import { isIP } from 'node:net';

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const values = parts.map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return (((values[0]! * 256 + values[1]!) * 256 + values[2]!) * 256 + values[3]!) >>> 0;
}

function ipv4InCidr(address: number, base: string, bits: number): boolean {
  const baseValue = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseValue & mask);
}

function isNonPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  return [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ].some(([base, bits]) => ipv4InCidr(value, base as string, bits as number));
}

function isNonPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]!;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff') || normalized.startsWith('2001:db8:') || normalized.startsWith('64:ff9b:') || normalized.startsWith('2002:')) return true;
  if (normalized.startsWith('::ffff:')) return isNonPublicIpv4(normalized.slice('::ffff:'.length));
  if (normalized.startsWith('::') && normalized.includes('.')) return isNonPublicIpv4(normalized.slice(2));
  return false;
}

export function assertPublicNpmNetworkAddresses(
  addresses: readonly string[],
  options: Readonly<{ allowPrivateNetwork?: boolean }> = {},
): void {
  if (addresses.length === 0) throw new Error('Npm registry DNS lookup returned no addresses');
  for (const address of addresses) {
    const family = isIP(address);
    if (family === 0 || (!options.allowPrivateNetwork && (family === 4 ? isNonPublicIpv4(address) : isNonPublicIpv6(address)))) {
      throw new Error('Npm registry DNS resolved to a private, local, reserved, or invalid address');
    }
  }
}

export function assertSafeNpmHttpsUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid npm registry URL'); }
  if (url.protocol !== 'https:') throw new Error('Npm registry requests require HTTPS');
  if (url.username || url.password) throw new Error('Npm registry URL credentials are forbidden');
  if (!url.hostname || url.hostname.toLowerCase() === 'localhost') throw new Error('Npm registry URL must use a public host');
  return url;
}
