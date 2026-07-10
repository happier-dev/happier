export type ProviderIpLocality = 'public' | 'private' | 'loopback' | 'unsafe';

export type ParsedProviderIpAddress = Readonly<{
  version: 4 | 6;
  normalized: string;
  locality: ProviderIpLocality;
}>;

function parseCanonicalIpv4(input: string): readonly number[] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

type Ipv4PolicyRange = Readonly<{
  cidr: string;
  network: number;
  prefixLength: number;
  locality: ProviderIpLocality;
}>;

function ipv4OctetsToNumber(octets: readonly number[]): number {
  return (
    ((octets[0] ?? 0) * 0x1_00_00_00)
    + ((octets[1] ?? 0) * 0x1_00_00)
    + ((octets[2] ?? 0) * 0x1_00)
    + (octets[3] ?? 0)
  ) >>> 0;
}

function createIpv4PolicyRange(cidr: string, locality: ProviderIpLocality): Ipv4PolicyRange {
  const [address = '', prefixRaw = ''] = cidr.split('/');
  const octets = parseCanonicalIpv4(address);
  const prefixLength = Number(prefixRaw);
  if (!octets || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Invalid built-in IPv4 policy range: ${cidr}`);
  }
  const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return Object.freeze({
    cidr,
    network: (ipv4OctetsToNumber(octets) & mask) >>> 0,
    prefixLength,
    locality,
  });
}

// IANA IPv4 Special-Purpose Address Registry, reviewed 2026-07-10:
// https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
// Longest-prefix
// selection is required because globally reachable and locally usable exceptions live
// inside otherwise unsafe parent allocations (notably 192.0.0.0/24 and 192.88.99.0/24).
// Exact metadata destinations are listed separately inside otherwise confirmable ranges.
const IPV4_POLICY_RANGES: readonly Ipv4PolicyRange[] = Object.freeze([
  createIpv4PolicyRange('0.0.0.0/8', 'unsafe'),
  createIpv4PolicyRange('10.0.0.0/8', 'private'),
  createIpv4PolicyRange('100.64.0.0/10', 'private'),
  createIpv4PolicyRange('100.100.100.200/32', 'unsafe'), // Alibaba ECS/ENS metadata
  createIpv4PolicyRange('127.0.0.0/8', 'loopback'),
  createIpv4PolicyRange('169.254.0.0/16', 'private'),
  createIpv4PolicyRange('169.254.169.254/32', 'unsafe'), // EC2 and common cloud IMDS
  createIpv4PolicyRange('169.254.170.2/32', 'unsafe'), // ECS task credentials
  createIpv4PolicyRange('169.254.170.23/32', 'unsafe'), // EKS Pod Identity credentials
  createIpv4PolicyRange('172.16.0.0/12', 'private'),
  createIpv4PolicyRange('192.0.0.0/24', 'unsafe'),
  createIpv4PolicyRange('192.0.0.0/29', 'private'),
  createIpv4PolicyRange('192.0.0.8/32', 'unsafe'),
  createIpv4PolicyRange('192.0.0.9/32', 'public'),
  createIpv4PolicyRange('192.0.0.10/32', 'public'),
  createIpv4PolicyRange('192.0.0.170/32', 'unsafe'),
  createIpv4PolicyRange('192.0.0.171/32', 'unsafe'),
  createIpv4PolicyRange('192.0.2.0/24', 'unsafe'),
  createIpv4PolicyRange('192.31.196.0/24', 'public'),
  createIpv4PolicyRange('192.52.193.0/24', 'public'),
  createIpv4PolicyRange('192.88.99.0/24', 'unsafe'),
  createIpv4PolicyRange('192.88.99.2/32', 'private'),
  createIpv4PolicyRange('192.168.0.0/16', 'private'),
  createIpv4PolicyRange('192.175.48.0/24', 'public'),
  createIpv4PolicyRange('198.18.0.0/15', 'private'),
  createIpv4PolicyRange('198.51.100.0/24', 'unsafe'),
  createIpv4PolicyRange('203.0.113.0/24', 'unsafe'),
  createIpv4PolicyRange('224.0.0.0/4', 'unsafe'),
  createIpv4PolicyRange('240.0.0.0/4', 'unsafe'),
  createIpv4PolicyRange('255.255.255.255/32', 'unsafe'),
]);

function matchesIpv4PolicyRange(value: number, range: Ipv4PolicyRange): boolean {
  const mask = range.prefixLength === 0 ? 0 : (0xffff_ffff << (32 - range.prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === range.network;
}

function classifyIpv4(octets: readonly number[]): ProviderIpLocality {
  const value = ipv4OctetsToNumber(octets);
  let selected: Ipv4PolicyRange | null = null;
  for (const range of IPV4_POLICY_RANGES) {
    if (
      matchesIpv4PolicyRange(value, range)
      && (selected === null || range.prefixLength > selected.prefixLength)
    ) {
      selected = range;
    }
  }
  return selected?.locality ?? 'public';
}

function parseIpv6Words(input: string): readonly number[] | null {
  if (input.includes('%')) return null;
  let normalizedInput = input.toLowerCase();
  const lastColon = normalizedInput.lastIndexOf(':');
  const ipv4Tail = normalizedInput.slice(lastColon + 1);
  if (ipv4Tail.includes('.')) {
    const octets = parseCanonicalIpv4(ipv4Tail);
    if (!octets) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalizedInput = `${normalizedInput.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const pieces = normalizedInput.split('::');
  if (pieces.length > 2) return null;
  const head = pieces[0] ? pieces[0].split(':') : [];
  const tail = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  if (pieces.length === 1 && head.length !== 8) return null;
  if (pieces.length === 2 && head.length + tail.length >= 8) return null;

  const parseWord = (word: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/u.test(word)) return null;
    return Number.parseInt(word, 16);
  };
  const headWords = head.map(parseWord);
  const tailWords = tail.map(parseWord);
  if (headWords.some((word) => word === null) || tailWords.some((word) => word === null)) return null;
  const zeroCount = 8 - headWords.length - tailWords.length;
  return [
    ...headWords as number[],
    ...Array.from({ length: zeroCount }, () => 0),
    ...tailWords as number[],
  ];
}

function formatIpv6(words: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    const length = end - index;
    if (length > bestLength && length >= 2) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }

  const rendered = words.map((word) => word.toString(16));
  if (bestStart < 0) return rendered.join(':');
  const before = rendered.slice(0, bestStart).join(':');
  const after = rendered.slice(bestStart + bestLength).join(':');
  if (!before && !after) return '::';
  if (!before) return `::${after}`;
  if (!after) return `${before}::`;
  return `${before}::${after}`;
}

function wordsToBigInt(words: readonly number[]): bigint {
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

type Ipv6PolicyRange = Readonly<{
  cidr: string;
  network: bigint;
  prefixLength: number;
  locality: ProviderIpLocality;
}>;

function createIpv6PolicyRange(cidr: string, locality: ProviderIpLocality): Ipv6PolicyRange {
  const slash = cidr.lastIndexOf('/');
  const address = slash >= 0 ? cidr.slice(0, slash) : '';
  const prefixLength = slash >= 0 ? Number(cidr.slice(slash + 1)) : Number.NaN;
  const words = parseIpv6Words(address);
  if (!words || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
    throw new Error(`Invalid built-in IPv6 policy range: ${cidr}`);
  }
  const shift = 128n - BigInt(prefixLength);
  const value = wordsToBigInt(words);
  return Object.freeze({
    cidr,
    network: shift === 128n ? 0n : (value >> shift) << shift,
    prefixLength,
    locality,
  });
}

// IANA IPv6 Special-Purpose Address Registry, reviewed 2026-07-10:
// https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
// Entries that
// carry an embedded IPv4 address are handled before this table so the embedded
// destination cannot escape its IPv4 policy through a transition prefix.
const IPV6_POLICY_RANGES: readonly Ipv6PolicyRange[] = Object.freeze([
  createIpv6PolicyRange('64:ff9b:1::/48', 'private'),
  createIpv6PolicyRange('100::/64', 'unsafe'),
  createIpv6PolicyRange('100:0:0:1::/64', 'unsafe'),
  createIpv6PolicyRange('2001::/23', 'unsafe'),
  createIpv6PolicyRange('2001::/32', 'private'),
  createIpv6PolicyRange('2001:1::1/128', 'public'),
  createIpv6PolicyRange('2001:1::2/128', 'public'),
  createIpv6PolicyRange('2001:1::3/128', 'public'),
  createIpv6PolicyRange('2001:2::/48', 'private'),
  createIpv6PolicyRange('2001:3::/32', 'public'),
  createIpv6PolicyRange('2001:4:112::/48', 'public'),
  createIpv6PolicyRange('2001:10::/28', 'unsafe'),
  createIpv6PolicyRange('2001:20::/28', 'public'),
  createIpv6PolicyRange('2001:30::/28', 'public'),
  createIpv6PolicyRange('2001:db8::/32', 'unsafe'),
  createIpv6PolicyRange('2620:4f:8000::/48', 'public'),
  createIpv6PolicyRange('3fff::/20', 'unsafe'),
  createIpv6PolicyRange('5f00::/16', 'private'),
  createIpv6PolicyRange('fc00::/7', 'private'),
  createIpv6PolicyRange('fd00:ec2::254/128', 'unsafe'),
  createIpv6PolicyRange('fe80::/10', 'private'),
  createIpv6PolicyRange('fec0::/10', 'private'), // RFC 3879 existing-deployment compatibility
  createIpv6PolicyRange('ff00::/8', 'unsafe'),
]);

function matchesIpv6PolicyRange(value: bigint, range: Ipv6PolicyRange): boolean {
  const shift = 128n - BigInt(range.prefixLength);
  return shift === 128n ? true : (value >> shift) === (range.network >> shift);
}

function classifyEmbeddedIpv4(value: bigint): ProviderIpLocality {
  const embedded = Number(value & 0xffff_ffffn);
  return classifyIpv4([
    (embedded >>> 24) & 0xff,
    (embedded >>> 16) & 0xff,
    (embedded >>> 8) & 0xff,
    embedded & 0xff,
  ]);
}

function classifyIpv6(words: readonly number[]): ProviderIpLocality {
  const value = wordsToBigInt(words);
  if (value === 1n) return 'loopback';
  if (value === 0n) return 'unsafe';

  // IPv4-mapped IPv6 is classified exactly like the embedded IPv4 address.
  if ((value >> 32n) === 0xffffn) {
    return classifyEmbeddedIpv4(value);
  }
  // Deprecated IPv4-compatible IPv6 literals can bypass IPv4-oriented policy while being
  // interpreted as IPv4 by transition machinery. Only :: and ::1 have already been handled.
  if ((value >> 32n) === 0n) return 'unsafe';

  // RFC 6052 Well-Known Prefix (/96): the low 32 bits are the translated IPv4.
  const wellKnownNat64Prefix = 0x0064_ff9b_0000_0000_0000_0000n;
  if ((value >> 32n) === wellKnownNat64Prefix) {
    return classifyEmbeddedIpv4(value);
  }

  // RFC 3056 6to4: bits 16..47 are the source-real IPv4 address.
  if ((value >> 112n) === 0x2002n) {
    return classifyEmbeddedIpv4(value >> 80n);
  }

  let selected: Ipv6PolicyRange | null = null;
  for (const range of IPV6_POLICY_RANGES) {
    if (
      matchesIpv6PolicyRange(value, range)
      && (selected === null || range.prefixLength > selected.prefixLength)
    ) {
      selected = range;
    }
  }
  if (selected) return selected.locality;

  // IANA IPv6 Address Space Registry, reviewed 2026-07-10:
  // https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space.xhtml
  // Only 2000::/3 is
  // presently allocated as Global Unicast. More-specific special-purpose and
  // transition ranges outside it have already been handled above; all remaining
  // top-level space is reserved rather than implicitly internet-reachable.
  return (words[0] ?? 0) >= 0x2000 && (words[0] ?? 0) <= 0x3fff ? 'public' : 'unsafe';
}

export function parseProviderIpAddress(input: string): ParsedProviderIpAddress | null {
  const raw = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  const ipv4 = parseCanonicalIpv4(raw);
  if (ipv4) {
    return {
      version: 4,
      normalized: ipv4.join('.'),
      locality: classifyIpv4(ipv4),
    };
  }
  const ipv6 = parseIpv6Words(raw);
  if (!ipv6) return null;
  return {
    version: 6,
    normalized: formatIpv6(ipv6),
    locality: classifyIpv6(ipv6),
  };
}

export function classifyProviderHostnameSyntax(hostname: string): 'hostname' | 'loopback' {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost') ? 'loopback' : 'hostname';
}
