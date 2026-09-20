# Neon Founder ID — deployment guide

This project has two parts that must be hosted together:

1. **Website**: the React/Vite interface.
2. **Photo-processing API**: the Node.js server that receives a photo, sends the image and poster template to Kie.ai, waits for the render, and serves the resulting image.

> **Important:** GitHub Pages can host only the static site. It cannot run `server.js`, store API keys, process uploads, or call Kie.ai. For a working public kiosk, deploy the Node server to a Windows/Linux host and point your domain to that server through Cloudflare Tunnel.

---

## 1. Requirements

- A machine that stays online (Windows 10/11, Windows Server, or Linux VPS)
- Node.js 22 LTS or newer
- pnpm 10+ (the lockfile was created with pnpm 11)
- A Kie.ai account and API key with access to the configured image model
- A Cloudflare account with your domain added to Cloudflare DNS
- Cloudflare Tunnel (`cloudflared`)

Check local tools:

```powershell
node --version
pnpm --version
cloudflared --version
```

---

## 2. Unpack and install the app

```powershell
cd C:\Sites
Expand-Archive .\neon-founder-id-full.zip -DestinationPath .\neon-founder-id
cd .\neon-founder-id
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` creates `dist/`. In production `server.js` automatically serves the built web site from that folder, as well as `/api/process-photo` and `/results`.

---

## 3. Configure Kie.ai

Create the runtime configuration file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set at minimum:

```dotenv
KIE_API_KEY=put-your-real-kie-api-key-here
KIE_IMAGE_MODEL=nano-banana-pro
KIE_BASE_URL=https://api.kie.ai
KIE_UPLOAD_BASE_URL=https://kieai.redpandaai.co
PORT=8787
```

### Key safety

- Never commit `.env` to Git.
- Never paste its contents into chat, tickets, or screenshots.
- Rotate a key immediately if it was exposed.
- The app sends each uploaded participant photo and the selected template to Kie.ai for image generation. Obtain consent and publish your privacy notice before public use.

### Test locally

```powershell
pnpm start
```

Open `http://127.0.0.1:8787`. Test the questionnaire, photo upload, and generated result. Stop the server with `Ctrl+C` before installing it as a service.

---

## 4. Create a Cloudflare named tunnel

Do this in a PowerShell session on the server that will run this app.

### 4.1 Authenticate

```powershell
cloudflared tunnel login
```

The command opens a browser. Select the Cloudflare zone that contains your domain.

### 4.2 Create tunnel and DNS route

Use your own names. Example uses `neon-kiosk` and `app.example.com`.

```powershell
cloudflared tunnel create neon-kiosk
cloudflared tunnel route dns neon-kiosk app.example.com
```

Cloudflare outputs a tunnel UUID and writes a credentials JSON file. Keep it private.

### 4.3 Configure ingress

Copy the provided example and edit its UUID, credential-file path, and hostname:

```powershell
Copy-Item .\deploy\cloudflared-config.example.yml .\deploy\cloudflared-config.yml
notepad .\deploy\cloudflared-config.yml
```

Example final config:

```yaml
tunnel: 11111111-2222-3333-4444-555555555555
credentials-file: C:\Users\Administrator\.cloudflared\11111111-2222-3333-4444-555555555555.json

ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

### 4.4 Run and verify the tunnel

First keep it in the foreground for testing:

```powershell
cloudflared tunnel --config .\deploy\cloudflared-config.yml run neon-kiosk
```

Open `https://app.example.com`. The homepage should load over HTTPS. A named tunnel is preferred; do **not** rely on a random `trycloudflare.com` URL for a public production kiosk.

---

## 5. Keep the application running

### Option A — Windows Task Scheduler

Create a task that starts on boot, runs whether a user is logged in or not, and has two actions:

1. Start app:
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `server.js`
   - Start in: `C:\Sites\neon-founder-id`
2. Start tunnel:
   - Program: full path to `cloudflared.exe`
   - Arguments: `tunnel --config "C:\Sites\neon-founder-id\deploy\cloudflared-config.yml" run neon-kiosk`
   - Start in: `C:\Sites\neon-founder-id`

Use the same Windows account that can read `.env` and the Cloudflare tunnel credentials. Redirect output to log files or configure Task Scheduler history for troubleshooting.

### Option B — cloudflared Windows service

Install cloudflared using its official Windows service setup, then configure the named tunnel. The exact configuration/credential path depends on the account that runs the service. See the official Cloudflare Tunnel documentation before enabling this on a production machine.

For Node.js, use a service manager such as NSSM or a scheduled task. The key requirement is that the process runs:

```powershell
cd C:\Sites\neon-founder-id
pnpm build
pnpm start
```

### Option C — Linux (systemd)

Create separate `systemd` services for the Node app and `cloudflared`, make both start after network availability, then run:

```bash
cd /opt/neon-founder-id
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Use environment permissions such as `chmod 600 .env` and do not run the Node app as root.

---

## 6. Update procedure

For every source update:

```powershell
cd C:\Sites\neon-founder-id
git pull
pnpm install --frozen-lockfile
pnpm build
```

Restart the Node application service/task. You usually do **not** need to restart the tunnel unless its configuration changed.

---

## 7. Rendering and output settings

`server.js` is configured for a fast workflow:

- Kie.ai generation: `resolution: "1K"`
- maximum polling time: **2 minutes**
- final result: **720×960 JPEG** at quality 85

Change these constants near the top of `server.js` if needed:

```js
const resultWidth = 720;
const resultHeight = 960;
```

and the Kie task payload:

```js
resolution: "1K"
```

Higher quality/resolution costs more and can take longer. Render duration also depends on Kie.ai queue time and cannot be guaranteed by this application.

---

## 8. Profiles and templates

- Student templates: `public/templates/architect.png`, `innovator.png`, `owner.png`, `hybrid.jpg`
- Professional templates: `public/templates/pro-architect.png`, `pro-innovator.png`, `pro-owner.png`, `pro-hybrid.png`

Profile selection and audience routing are in `src/main.tsx` and `server.js`.

---

## 9. Troubleshooting

### Site loads but photo processing fails

1. Confirm the Node process is running: `http://127.0.0.1:8787`.
2. Check app logs / console for Kie.ai HTTP errors.
3. Verify `.env` contains a valid `KIE_API_KEY`.
4. Verify outbound HTTPS access from the server to `api.kie.ai` and `kieai.redpandaai.co`.
5. Confirm the selected Kie.ai model is available to the API key.

### Cloudflare error 1033

The tunnel connector is offline or disconnected. On the host, make sure `cloudflared` is still running and can reach Cloudflare. Named tunnels plus a Windows service/system service are much more reliable than Quick Tunnels.

### A result has a pasted/unnatural face

That indicates the Kie.ai path failed and the application returned its local fallback. Review the API logs and fix Kie.ai credentials/connectivity before public use.

### GitHub Pages works but processing does not

Expected: Pages hosts static files only. Use the custom domain that points through Cloudflare Tunnel to the Node server for the complete application.

---

## 10. Security checklist

- [ ] `.env` is excluded from Git and backups shared with others.
- [ ] Use a named Cloudflare Tunnel, not a Quick Tunnel.
- [ ] Restrict host access and regularly update Node.js/cloudflared.
- [ ] Obtain consent before uploading participant photos.
- [ ] Regularly delete old files from `public/results`.
- [ ] Set a retention policy and document it in your privacy notice.
- [ ] Test as a non-admin user where possible.

---

## GitHub Pages note

The repository includes a Pages workflow for a static preview. It is useful for showing the questionnaire UI, but it has no API runtime. For end-to-end photo generation, use the domain fronted by Cloudflare Tunnel and the Node server described above.
