import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

type RelayRuntimeMode = 'user' | 'system';

type RelayRuntimePlatform = NodeJS.Platform;

type RelayRuntimeBackend =
  | 'systemd-user'
  | 'systemd-system'
  | 'launchd-user'
  | 'launchd-system'
  | 'schtasks-user'
  | 'schtasks-system';

type RelayRuntimeServiceRaw =
  | Readonly<{
      unitFileState?: string | null;
      activeState?: string | null;
      subState?: string | null;
    }>
  | Readonly<{
      exists?: boolean | null;
      enabled?: boolean | null;
      active?: boolean | null;
      stateLabel?: string | null;
    }>
  | Readonly<{
      loaded?: boolean | null;
      pid?: number | null;
      lastExitStatus?: number | null;
    }>;

export type RelayRuntimeDefaults = Readonly<{
  channel: PublicReleaseRingId;
  mode: RelayRuntimeMode;
  installRoot: string;
  binDir: string;
  configDir: string;
  dataDir: string;
  logDir: string;
  serviceName: string;
  serverHost: string;
  serverPort: number;
  healthPath: string;
}>;

export type RelayRuntimeNormalizedStatus = Readonly<{
  installed: boolean;
  version: string | null;
  service: Readonly<{
    backend: RelayRuntimeBackend;
    installed: boolean;
    enabled: boolean;
    active: boolean;
    stateLabel: string;
  }>;
  health: Readonly<{
    reachable: boolean;
    portOpen: boolean;
    pingOk: boolean;
    url: string;
  }>;
}>;

export type RelayRuntimeHealthResult = Readonly<{
  reachable: boolean;
  portOpen: boolean;
  pingOk: boolean;
  url: string;
  statusCode: number | null;
  version: string | null;
}>;

function resolveChannelSuffix(channel: PublicReleaseRingId): string {
  if (channel === 'stable') return '';
  if (channel === 'preview') return 'preview';
  return 'dev';
}

function appendChannelSuffix(base: string, channel: PublicReleaseRingId): string {
  const suffix = resolveChannelSuffix(channel);
  return suffix ? `${base}-${suffix}` : base;
}

function normalizeMode(raw: unknown): RelayRuntimeMode {
  return String(raw ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
}

function normalizeChannel(raw: unknown): PublicReleaseRingId {
  const normalized = normalizePublicReleaseRingId(String(raw ?? '').trim());
  return normalized === 'stable' || normalized === 'preview' || normalized === 'publicdev'
    ? normalized
    : 'stable';
}

function buildRelayRuntimeUrl(params: Readonly<{
  host: string;
  port: number;
  path: string;
}>): string {
  const path = String(params.path ?? '').trim() || '/v1/version';
  return `http://${params.host}:${params.port}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeSystemdStatus(raw: RelayRuntimeServiceRaw): RelayRuntimeNormalizedStatus['service'] {
  const unitFileState = String((raw as { unitFileState?: unknown }).unitFileState ?? '').trim().toLowerCase();
  const activeState = String((raw as { activeState?: unknown }).activeState ?? '').trim().toLowerCase();
  const subState = String((raw as { subState?: unknown }).subState ?? '').trim().toLowerCase();
  const installed = unitFileState.length > 0 || activeState.length > 0 || subState.length > 0;
  const enabled = unitFileState === 'enabled';
  const active = activeState === 'active';
  return {
    backend: 'systemd-user',
    installed,
    enabled,
    active,
    stateLabel: subState || activeState || (installed ? 'configured' : 'not_installed'),
  };
}

function normalizeLaunchdStatus(raw: RelayRuntimeServiceRaw): RelayRuntimeNormalizedStatus['service'] {
  const loaded = (raw as { loaded?: unknown }).loaded === true;
  const pidRaw = (raw as { pid?: unknown }).pid;
  const lastExitStatusRaw = (raw as { lastExitStatus?: unknown }).lastExitStatus;
  const pid = typeof pidRaw === 'number' && Number.isFinite(pidRaw) ? pidRaw : null;
  const lastExitStatus = typeof lastExitStatusRaw === 'number' && Number.isFinite(lastExitStatusRaw) ? lastExitStatusRaw : null;
  const active = loaded && (pid ?? 0) > 0;
  const stateLabel = active ? 'running' : loaded ? 'loaded' : lastExitStatus === 0 ? 'stopped' : 'not_loaded';
  return {
    backend: 'launchd-user',
    installed: loaded || lastExitStatus !== null,
    enabled: loaded,
    active,
    stateLabel,
  };
}

function normalizeSchtasksStatus(raw: RelayRuntimeServiceRaw): RelayRuntimeNormalizedStatus['service'] {
  const exists = (raw as { exists?: unknown }).exists === true;
  const enabled = (raw as { enabled?: unknown }).enabled === true;
  const active = (raw as { active?: unknown }).active === true;
  const stateLabel = String((raw as { stateLabel?: unknown }).stateLabel ?? '').trim() || (exists ? (active ? 'running' : 'ready') : 'not_installed');
  return {
    backend: 'schtasks-user',
    installed: exists,
    enabled: exists && enabled,
    active: exists && active,
    stateLabel,
  };
}

export function resolveRelayRuntimeDefaults(params: Readonly<{
  platform?: RelayRuntimePlatform;
  mode?: RelayRuntimeMode;
  channel?: PublicReleaseRingId;
  homeDir?: string;
}> = {}): RelayRuntimeDefaults {
  const platform = (String(params.platform ?? process.platform).trim() || process.platform) as RelayRuntimePlatform;
  const mode = normalizeMode(params.mode);
  const channel = normalizeChannel(params.channel);
  const homeDir = String(params.homeDir ?? '').trim();

  if (mode === 'system') {
    return {
      channel,
      mode,
      installRoot: appendChannelSuffix('/opt/happier', channel),
      binDir: '/usr/local/bin',
      configDir: appendChannelSuffix('/etc/happier', channel),
      dataDir: appendChannelSuffix('/var/lib/happier', channel),
      logDir: appendChannelSuffix('/var/log/happier', channel),
      serviceName: appendChannelSuffix('happier-server', channel),
      serverHost: '127.0.0.1',
      serverPort: 3005,
      healthPath: '/v1/version',
    };
  }

  const happierHome = platform === 'win32'
    ? `${homeDir || 'C:\\Users\\Default'}\\.happier`
    : `${homeDir || '/tmp'}/.happier`;
  const installRoot = appendChannelSuffix(
    platform === 'win32' ? `${happierHome}\\self-host` : `${happierHome}/self-host`,
    channel,
  );

  return {
    channel,
    mode,
    installRoot,
    binDir: platform === 'win32' ? `${happierHome}\\bin` : `${happierHome}/bin`,
    configDir: platform === 'win32' ? `${installRoot}\\config` : `${installRoot}/config`,
    dataDir: platform === 'win32' ? `${installRoot}\\data` : `${installRoot}/data`,
    logDir: platform === 'win32' ? `${installRoot}\\logs` : `${installRoot}/logs`,
    serviceName: appendChannelSuffix('happier-server', channel),
    serverHost: '127.0.0.1',
    serverPort: 3005,
    healthPath: '/v1/version',
  };
}

export function normalizeRelayRuntimeStatus(params: Readonly<{
  platform?: RelayRuntimePlatform;
  installVersion: string | null;
  service: Readonly<{
    backend: RelayRuntimeBackend;
    raw: RelayRuntimeServiceRaw;
  }>;
  health: Readonly<{
    portOpen: boolean;
    pingOk: boolean;
    url: string;
  }>;
}>): RelayRuntimeNormalizedStatus {
  const backend = params.service.backend;
  const normalizedService =
    backend.startsWith('systemd')
      ? normalizeSystemdStatus(params.service.raw)
      : backend.startsWith('launchd')
        ? normalizeLaunchdStatus(params.service.raw)
        : normalizeSchtasksStatus(params.service.raw);

  return {
    installed: typeof params.installVersion === 'string' && params.installVersion.trim().length > 0,
    version: typeof params.installVersion === 'string' && params.installVersion.trim().length > 0
      ? params.installVersion.trim()
      : null,
    service: {
      ...normalizedService,
      backend,
    },
    health: {
      reachable: params.health.portOpen === true && params.health.pingOk === true,
      portOpen: params.health.portOpen === true,
      pingOk: params.health.pingOk === true,
      url: params.health.url,
    },
  };
}

export async function checkRelayRuntimeHealth(params: Readonly<{
  host: string;
  port: number;
  path?: string;
  timeoutMs: number;
  probePortOpen: (params: Readonly<{ host: string; port: number; timeoutMs: number }>) => Promise<boolean>;
  fetchJson: (params: Readonly<{ url: string; timeoutMs: number }>) => Promise<Readonly<{
    ok: boolean;
    status: number;
    body: unknown;
  }>>;
}>): Promise<RelayRuntimeHealthResult> {
  const host = String(params.host ?? '').trim() || '127.0.0.1';
  const port = Number.isFinite(params.port) ? Math.floor(params.port) : 3005;
  const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs)) : 30_000;
  const url = buildRelayRuntimeUrl({ host, port, path: params.path ?? '/v1/version' });

  const portOpen = await params.probePortOpen({ host, port, timeoutMs });
  if (!portOpen) {
    return {
      reachable: false,
      portOpen: false,
      pingOk: false,
      url,
      statusCode: null,
      version: null,
    };
  }

  const response = await params.fetchJson({ url, timeoutMs });
  const body = response.body;
  const version = body && typeof body === 'object' && typeof (body as { version?: unknown }).version === 'string'
    ? String((body as { version: string }).version)
    : null;
  const pingOk = response.ok === true;

  return {
    reachable: portOpen && pingOk,
    portOpen,
    pingOk,
    url,
    statusCode: typeof response.status === 'number' ? response.status : null,
    version,
  };
}
