import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';

import {
  runTailscaleStatusJson,
  type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';

import { tailscaleServeHttpsUrlForInternalServerUrl } from '@/integrations/tailscale/tailscaleServe';

export type CurrentMachineReachableServerUrlCandidateSource =
  | 'tailscale-serve'
  | 'tailscale-ip'
  | 'lan'
  | 'network-interface';

export type CurrentMachineReachableServerUrlCandidate = Readonly<{
  url: string;
  source: CurrentMachineReachableServerUrlCandidateSource;
  label: string;
  detail: string | null;
  verified: boolean;
}>;

export type CurrentMachineNetworkAddressCandidate = Readonly<{
  address: string;
  family: 4 | 6;
  iface: string;
  source: Exclude<CurrentMachineReachableServerUrlCandidateSource, 'tailscale-serve'>;
  label: string;
}>;

export type NetworkInterfaceAddressLike = Readonly<{
  address?: string;
  family?: string | number;
  internal?: boolean;
}>;

type NetworkInterfacesLike = Record<string, readonly NetworkInterfaceAddressLike[] | undefined>;

type TcpProbeParams = Readonly<{
  host: string;
  port: number;
  timeoutMs: number;
}>;

export type CurrentMachineReachableServerUrlCandidateDeps = Readonly<{
  getNetworkInterfaces?: () => NetworkInterfacesLike;
  resolveTailscaleServeUrl?: (params: Readonly<{
    internalServerUrl: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }>) => Promise<string | null>;
  resolveTailscaleIps?: (params: Readonly<{
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }>) => Promise<readonly string[]>;
  canConnectToTcpEndpoint?: (params: TcpProbeParams) => Promise<boolean>;
}>;

const DEFAULT_PROBE_TIMEOUT_MS = 250;
const DEFAULT_TAILSCALE_TIMEOUT_MS = 750;

function normalizeUrl(raw: string): string {
  return new URL(raw).toString().replace(/\/+$/, '');
}

function parseIpFamily(raw: string): 4 | 6 | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return 4;
  if (value.includes(':')) return 6;
  return null;
}

function readInterfaceFamily(entry: NetworkInterfaceAddressLike): 4 | 6 | null {
  const family = entry.family;
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return parseIpFamily(String(entry.address ?? ''));
}

function isLoopbackIpv4(address: string): boolean {
  return address.startsWith('127.');
}

function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith('169.254.');
}

function isPrivateIpv4(address: string): boolean {
  if (/^10\./.test(address)) return true;
  if (/^192\.168\./.test(address)) return true;
  const match = address.match(/^172\.(\d+)\./);
  if (!match) return false;
  const octet = Number(match[1]);
  return octet >= 16 && octet <= 31;
}

function isTailscaleIpv4(address: string): boolean {
  const match = address.match(/^100\.(\d+)\./);
  if (!match) return false;
  const octet = Number(match[1]);
  return octet >= 64 && octet <= 127;
}

function isLoopbackIpv6(address: string): boolean {
  return address === '::1';
}

function isLinkLocalIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb');
}

function isUniqueLocalIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd');
}

function classifyNetworkAddress(params: Readonly<{
  address: string;
  family: 4 | 6;
  iface: string;
  tailscaleIps: ReadonlySet<string>;
}>): CurrentMachineNetworkAddressCandidate['source'] {
  if (params.tailscaleIps.has(params.address) || (params.family === 4 && isTailscaleIpv4(params.address))) {
    return 'tailscale-ip';
  }
  if (
    (params.family === 4 && isPrivateIpv4(params.address)) ||
    (params.family === 6 && isUniqueLocalIpv6(params.address))
  ) {
    return 'lan';
  }
  return 'network-interface';
}

function labelForAddressSource(source: CurrentMachineNetworkAddressCandidate['source'], iface: string): string {
  if (source === 'tailscale-ip') return 'Tailscale IP';
  if (source === 'lan') return `LAN (${iface})`;
  return `Network interface (${iface})`;
}

function isAddressUsable(address: string, family: 4 | 6): boolean {
  if (family === 4) {
    return !isLoopbackIpv4(address) && !isLinkLocalIpv4(address);
  }
  return !isLoopbackIpv6(address) && !isLinkLocalIpv6(address) && !address.includes('%');
}

function defaultGetNetworkInterfaces(): NetworkInterfacesLike {
  return networkInterfaces() as NetworkInterfacesLike;
}

export function listCurrentMachineNetworkAddressCandidates(params: Readonly<{
  getNetworkInterfaces?: () => NetworkInterfacesLike;
  tailscaleIps?: readonly string[];
}> = {}): readonly CurrentMachineNetworkAddressCandidate[] {
  const ifaces = (params.getNetworkInterfaces ?? defaultGetNetworkInterfaces)();
  const tailscaleIps = new Set((params.tailscaleIps ?? []).map((value) => String(value).trim()).filter(Boolean));
  const seen = new Set<string>();
  const candidates: CurrentMachineNetworkAddressCandidate[] = [];

  for (const [iface, entries] of Object.entries(ifaces)) {
    for (const entry of entries ?? []) {
      const address = String(entry.address ?? '').trim();
      const family = readInterfaceFamily(entry);
      if (!address || !family || entry.internal === true || !isAddressUsable(address, family)) {
        continue;
      }

      const key = `${family}:${address}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const source = classifyNetworkAddress({ address, family, iface, tailscaleIps });
      candidates.push({
        address,
        family,
        iface,
        source,
        label: labelForAddressSource(source, iface),
      });
    }
  }

  return candidates.sort((left, right) => {
    const sourceRank = (source: CurrentMachineNetworkAddressCandidate['source']): number => {
      if (source === 'tailscale-ip') return 0;
      if (source === 'lan') return 1;
      return 2;
    };
    return sourceRank(left.source) - sourceRank(right.source) || left.iface.localeCompare(right.iface) || left.address.localeCompare(right.address);
  });
}

function resolvePort(url: URL): number | null {
  if (url.port) {
    const parsed = Number(url.port);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  if (url.protocol === 'http:') return 80;
  if (url.protocol === 'https:') return 443;
  return null;
}

function buildServerUrlForAddress(localServerUrl: URL, address: string): string {
  const host = parseIpFamily(address) === 6 ? `[${address}]` : address;
  const port = localServerUrl.port ? `:${localServerUrl.port}` : '';
  return `${localServerUrl.protocol}//${host}${port}`;
}

async function defaultCanConnectToTcpEndpoint(params: TcpProbeParams): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const socket = createConnection({ host: params.host, port: params.port });
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(params.timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function defaultResolveTailscaleIps(params: Readonly<{
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<readonly string[]> {
  try {
    const status: TailscaleStatusSnapshot = await runTailscaleStatusJson({
      timeoutMs: params.timeoutMs ?? DEFAULT_TAILSCALE_TIMEOUT_MS,
      env: params.env ?? process.env,
    });
    return status.loggedIn ? status.tailscaleIps : [];
  } catch {
    return [];
  }
}

function dedupeCandidates(
  candidates: readonly CurrentMachineReachableServerUrlCandidate[],
): CurrentMachineReachableServerUrlCandidate[] {
  const seen = new Set<string>();
  const result: CurrentMachineReachableServerUrlCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.url;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export async function collectCurrentMachineReachableServerUrlCandidates(
  params: Readonly<{
    localServerUrl: string;
    probeTimeoutMs?: number;
    tailscaleTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }>,
  deps: CurrentMachineReachableServerUrlCandidateDeps = {},
): Promise<readonly CurrentMachineReachableServerUrlCandidate[]> {
  const localServerUrl = new URL(params.localServerUrl);
  const port = resolvePort(localServerUrl);
  if (!port) return [];

  const tailscaleTimeoutMs = params.tailscaleTimeoutMs ?? DEFAULT_TAILSCALE_TIMEOUT_MS;
  const probeTimeoutMs = params.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const resolveTailscaleServeUrl = deps.resolveTailscaleServeUrl ?? tailscaleServeHttpsUrlForInternalServerUrl;
  const resolveTailscaleIps = deps.resolveTailscaleIps ?? defaultResolveTailscaleIps;
  const canConnectToTcpEndpoint = deps.canConnectToTcpEndpoint ?? defaultCanConnectToTcpEndpoint;

  const [tailscaleServeUrl, tailscaleIps] = await Promise.all([
    resolveTailscaleServeUrl({
      internalServerUrl: normalizeUrl(localServerUrl.toString()),
      timeoutMs: tailscaleTimeoutMs,
      env: params.env ?? process.env,
    }).catch(() => null),
    resolveTailscaleIps({
      timeoutMs: tailscaleTimeoutMs,
      env: params.env ?? process.env,
    }).catch(() => []),
  ]);

  const networkAddressCandidates = listCurrentMachineNetworkAddressCandidates({
    getNetworkInterfaces: deps.getNetworkInterfaces,
    tailscaleIps,
  });
  const networkAddressKeys = new Set(networkAddressCandidates.map((candidate) => `${candidate.family}:${candidate.address}`));
  const statusOnlyTailscaleCandidates = tailscaleIps.flatMap((address): CurrentMachineNetworkAddressCandidate[] => {
    const family = parseIpFamily(address);
    if (!family || !isAddressUsable(address, family)) return [];
    const key = `${family}:${address}`;
    if (networkAddressKeys.has(key)) return [];
    return [{
      address,
      family,
      iface: 'tailscale',
      source: 'tailscale-ip',
      label: 'Tailscale IP',
    }];
  });
  const addressCandidates = [...statusOnlyTailscaleCandidates, ...networkAddressCandidates];

  const directCandidates: Array<CurrentMachineReachableServerUrlCandidate | null> = await Promise.all(addressCandidates.map(async (addressCandidate) => {
    const reachable = await canConnectToTcpEndpoint({
      host: addressCandidate.address,
      port,
      timeoutMs: probeTimeoutMs,
    });
    if (!reachable) return null;
    return {
      url: buildServerUrlForAddress(localServerUrl, addressCandidate.address),
      source: addressCandidate.source,
      label: addressCandidate.label,
      detail: addressCandidate.iface,
      verified: true,
    } satisfies CurrentMachineReachableServerUrlCandidate;
  }));

  const tailscaleServeCandidates: CurrentMachineReachableServerUrlCandidate[] = tailscaleServeUrl
    ? [{
      url: normalizeUrl(tailscaleServeUrl),
      source: 'tailscale-serve',
      label: 'Tailscale Serve (HTTPS)',
      detail: null,
      verified: true,
    }]
    : [];

  return dedupeCandidates([
    ...tailscaleServeCandidates,
    ...directCandidates.filter((candidate): candidate is CurrentMachineReachableServerUrlCandidate => candidate !== null),
  ]);
}
