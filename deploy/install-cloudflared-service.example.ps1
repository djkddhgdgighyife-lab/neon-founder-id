# Requires an elevated PowerShell window.
# Build the web client before installing the service:
#   pnpm install --frozen-lockfile
#   pnpm build
#
# Then copy .env.example to .env and configure it.
# Replace the config path below with the final path on this computer.
cloudflared service install
cloudflared tunnel run --config "C:\path\to\app\deploy\cloudflared-config.yml" YOUR_TUNNEL_UUID
