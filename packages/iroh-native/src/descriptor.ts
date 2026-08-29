export const HOME_TUNNEL_ALPN = 'happier/home-tunnel/1' as const;
export const MACHINE_ALPN = 'happier/machine/1' as const;
export const TUNNEL_PREAMBLE = 0x01 as const;

export type IrohEndpointDescriptorV1 = Readonly<{
  endpointId: string;
  relayUrls?: readonly string[];
  directAddresses?: readonly string[];
}>;

const allowedKeys = new Set(['endpointId', 'relayUrls', 'directAddresses']);
// Iroh renders EndpointId as z-base-32 (52 lowercase characters). Keep the
// 64-hex form accepted by the protocol fixtures for mixed-version descriptors.
const endpointIdPattern = /^(?:[0-9a-fA-F]{64}|[023456789abcdefghijkmnopqrstuwxyz]{52})$/;
const addressPattern = /^[^\s/:]+(?::\d{1,5})?$/;

export function parseIrohEndpointDescriptor(value: unknown): IrohEndpointDescriptorV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Iroh descriptor');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowedKeys.has(key)) throw new TypeError(`Unknown Iroh descriptor field: ${key}`);
  if (typeof record.endpointId !== 'string' || !endpointIdPattern.test(record.endpointId)) throw new TypeError('Invalid Iroh endpointId');
  const parseList = (key: string): readonly string[] | undefined => {
    const raw = record[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length > 8 || raw.some(item => typeof item !== 'string' || item.length === 0 || item.length > 256)) throw new TypeError(`Invalid ${key}`);
    if (key === 'directAddresses' && raw.some(item => {
      if (!addressPattern.test(item as string)) return true;
      const port = (item as string).match(/:(\d{1,5})$/)?.[1];
      return port !== undefined && Number(port) > 65535;
    })) throw new TypeError('Invalid direct address');
    return [...raw] as string[];
  };
  const relayUrls = parseList('relayUrls');
  if (relayUrls?.some(url => {
    try {
      const parsed = new URL(url);
      return !['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '';
    } catch { return true; }
  })) throw new TypeError('Invalid relay URL');
  const directAddresses = parseList('directAddresses');
  return { endpointId: record.endpointId, ...(relayUrls ? { relayUrls } : {}), ...(directAddresses ? { directAddresses } : {}) };
}
