import { networkInterfaces } from 'node:os';

export function pickLanIpv4() {
  try {
    const ifaces = networkInterfaces();
    // Prefer en0 (typical Wi-Fi on macOS), then any non-internal IPv4.
    const preferred = ['en0', 'en1', 'eth0', 'wlan0'];
    for (const name of preferred) {
      const list = ifaces[name] ?? [];
      for (const i of list) {
        if (i && i.family === 'IPv4' && !i.internal && i.address) return i.address;
      }
    }
    for (const list of Object.values(ifaces)) {
      for (const i of list ?? []) {
        if (i && i.family === 'IPv4' && !i.internal && i.address) return i.address;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

