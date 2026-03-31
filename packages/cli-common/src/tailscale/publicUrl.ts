import type { TailscaleStatusSnapshot } from "./statusSnapshot.js";

function normalizeDnsName(value: string): string | null {
  const trimmed = value.trim().replace(/\.+$/, "");
  if (!trimmed) return null;
  if (/[\/\s]/.test(trimmed)) return null;
  return trimmed;
}

export function resolveTailscaleMachineHttpsUrlFromStatusSnapshot(snapshot: TailscaleStatusSnapshot): string | null {
  const dnsName = typeof snapshot.dnsName === "string" ? normalizeDnsName(snapshot.dnsName) : null;
  if (!dnsName) return null;
  try {
    const url = new URL(`https://${dnsName}`);
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

