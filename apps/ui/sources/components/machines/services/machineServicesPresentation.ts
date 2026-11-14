import { machineServiceNativeIdentityKeyV1 } from '@happier-dev/protocol/machines/machineServiceWatchesV1';
import { type DeploymentReviewServiceV1, type MachineServiceNativeRuntimeFactsV1 } from '@happier-dev/protocol/local/services/nativeRuntimeFactsV1';
import { type MachineServiceDiscoveryCandidateV1, type MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import type { IconName } from '@/components/ui/icons/Icon';
import { isMachineUnreachableFailureCode, resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

/**
 * Machine → Services (plan 30 §3.7–§3.8, lab `machine/services/list`): the admitted service rows grouped by who keeps
 * them. Each Environment deployed here is its own group (the row's real `environmentId`), then the infrastructure the
 * Machine's sites depend on, then what the person watches, then services a Workspace started, then plugin services.
 * An adopted watch stays outside the Environments even when its purpose is deployment. The grouping reads only the
 * row's own authority, Environment and lifecycle purpose.
 */
export type MachineServiceGroupKey =
  | `environment:${string}`
  | 'infrastructure'
  | 'watched'
  | 'development'
  | 'plugin';
const FIXED_GROUP_ORDER = ['infrastructure', 'watched', 'development', 'plugin'] as const;
const ENVIRONMENT_GROUP_PREFIX = 'environment:';

export function machineServiceGroupOf(
  row: Pick<MachineServiceRowV1, 'authority' | 'lifecyclePurpose' | 'environmentId'>,
): MachineServiceGroupKey {
  if (row.authority === 'plugin') return 'plugin';
  if (row.authority === 'project' && row.environmentId) return `environment:${row.environmentId}`;
  if (row.lifecyclePurpose === 'infrastructure') return 'infrastructure';
  return row.authority === 'project' ? 'development' : 'watched';
}

/** The Environment a group key names, or null for the fixed groups. */
export function machineServiceGroupEnvironmentId(key: string): string | null {
  return key.startsWith(ENVIRONMENT_GROUP_PREFIX) ? key.slice(ENVIRONMENT_GROUP_PREFIX.length) : null;
}

/**
 * The groups these rows fill, in reading order. Environments lead, ordered by their id so nothing moves when their
 * names arrive; groups no row fills are not drawn.
 */
export function machineServiceGroupKeys(rows: readonly MachineServiceRowV1[]): readonly MachineServiceGroupKey[] {
  const present = new Set(rows.map(machineServiceGroupOf));
  const environments = [...present].filter(key => key.startsWith(ENVIRONMENT_GROUP_PREFIX)).sort();
  return [...environments, ...FIXED_GROUP_ORDER.filter(key => present.has(key))];
}

/** The distinct Environments visible rows belong to: the exact demand for their headers. */
export function machineServiceEnvironmentIds(rows: readonly MachineServiceRowV1[]): readonly string[] {
  return [...new Set(rows.flatMap(row => row.authority === 'project' && row.environmentId ? [row.environmentId] : []))].sort();
}

/** An Environment health warning needs its readable front door; the service's underlying health stays unchanged. */
export function machineServiceCanShowHealthWarning(
  row: Pick<MachineServiceRowV1, 'authority' | 'lifecyclePurpose' | 'environmentId'>,
  environmentHeaders: ReadonlyMap<string, unknown>,
): boolean {
  const environmentId = machineServiceGroupEnvironmentId(machineServiceGroupOf(row));
  return environmentId === null || environmentHeaders.has(environmentId);
}

/**
 * The row's identity mark: what the service is (a container, a systemd unit, a Workspace's dev server), or the
 * infrastructure and plugin marks for those groups (lab `machine/services/list`: Caddy's globe, a container, a unit).
 */
export function machineServiceIcon(
  row: Pick<MachineServiceRowV1, 'authority' | 'lifecyclePurpose' | 'environmentId' | 'nativeInstance'>,
): IconName {
  const group = machineServiceGroupOf(row);
  if (group === 'infrastructure') return 'globe';
  if (group === 'plugin') return 'puzzle-piece';
  if (group === 'development') return 'code';
  return machineServiceKind(row) === 'compose' ? 'cube' : 'hard-drives';
}

/**
 * What kind of service the row is, from facts its producer supplies: the native adapter of a watched instance
 * ("systemd", "compose"), or Compose for a service an Environment deployed. A Workspace service says nothing.
 */
export function machineServiceKind(
  row: Pick<MachineServiceRowV1, 'authority' | 'environmentId' | 'nativeInstance'>,
): string | null {
  if (row.nativeInstance) return row.nativeInstance.adapter.localId;
  return row.authority === 'project' && row.environmentId ? 'compose' : null;
}

/**
 * What the service is, from its producer's kind and native display name ("systemd · caddy.service"). A native name
 * the title already shows is not repeated ("Compose", not "Compose · web" under "web").
 */
export function machineServiceIdentityLine(
  row: Pick<MachineServiceRowV1, 'authority' | 'environmentId' | 'nativeInstance' | 'native' | 'name' | 'nameResolution'>,
): string | null {
  const kind = machineServiceKind(row);
  const nativeName = row.native?.displayName ?? null;
  const parts = [
    kind === null ? null : kind === 'systemd' || kind === 'compose' ? t(`machineServices.kind.${kind}`) : kind,
    nativeName === machineServiceDisplayName(row) ? null : nativeName,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The controls the row offers now: only what its capabilities support for the generation it observed. Restart and
 * Stop act on a service that runs; Start on one that stopped or failed. An unanswered service has no generation.
 */
export function machineServiceControls(
  row: Pick<MachineServiceRowV1, 'generation' | 'state' | 'capabilities'>,
): Readonly<{ restart: boolean; stop: boolean; start: boolean }> {
  if (row.generation === null) return NO_CONTROLS;
  const down = row.state === 'stopped' || row.state === 'stopping';
  return {
    restart: row.capabilities.restart && !down,
    stop: row.capabilities.stop && !down,
    start: row.capabilities.start && (row.state === 'stopped' || row.state === 'failed'),
  };
}
const NO_CONTROLS = Object.freeze({ restart: false, stop: false, start: false });

/** How a row's state reads: healthy is quiet, a failure speaks, an unanswered read is never "stopped". */
export type MachineServiceStateTone =
  | 'neutral'
  | 'secondary'
  | 'warning'
  | 'danger';
export function machineServiceStateTone(
  state: MachineServiceRowV1['state'],
): MachineServiceStateTone {
  switch (state) {
    case 'running':
    case 'healthy':
    case 'starting':
    case 'detecting':
      return 'neutral';
    case 'stopping':
    case 'stopped':
      return 'secondary';
    case 'unhealthy':
    case 'unknown':
      return 'warning';
    case 'failed':
      return 'danger';
  }
}

/** Whether a row's state is said at all: running and healthy services stay quiet in the list. */
export function machineServiceStateSpeaks(state: MachineServiceRowV1['state']): boolean {
  return state !== 'running' && state !== 'healthy';
}

/**
 * What a running service's own health source says beside "Running" (lab `services/states` "Health not reported"):
 * a Compose service without a health check settles as running, not verified, and is never shown as healthy. Only
 * the health and native readiness facts the producer reports are read; a row without them says nothing more.
 */
export type MachineServiceHealthQualifier = 'noCheck' | 'notVerified' | 'failing' | 'degraded';
export function machineServiceHealthQualifier(
  row: Pick<MachineServiceRowV1, 'state' | 'health' | 'native'>,
): MachineServiceHealthQualifier | null {
  if (row.state !== 'running' || (!row.health && !row.native) || row.health?.expectedDown) return null;
  switch (row.health?.status) {
    case 'up': return null;
    case 'down': return 'failing';
    case 'degraded': return 'degraded';
  }
  if (row.native?.readiness === 'ready') return null;
  return row.native?.readiness === 'not_ready' ? 'notVerified' : 'noCheck';
}

const STATE_ORDER: Readonly<Record<MachineServiceRowV1['state'], number>> = {
  failed: 0,
  unhealthy: 1,
  unknown: 2,
  starting: 3,
  detecting: 3,
  stopping: 3,
  running: 4,
  healthy: 4,
  stopped: 5,
};
/** Work that needs the person first, then running work, then the rest; by name within each. */
export function compareMachineServices(
  left: MachineServiceRowV1,
  right: MachineServiceRowV1,
): number {
  return (
    STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
    left.name.localeCompare(right.name)
  );
}

export type MachineServiceRestart = 'never' | 'always' | 'onFailure' | 'unlessStopped';
const RESTART_POLICIES: Readonly<Record<string, MachineServiceRestart>> = {
  no: 'never', always: 'always', 'on-failure': 'onFailure', 'unless-stopped': 'unlessStopped',
};
const RESTARTS: ReadonlySet<string> = new Set(Object.values(RESTART_POLICIES));
/** Whether a declared restart fact is one Happier names in words (else it is shown as declared). */
export function isMachineServiceRestart(value: string): value is MachineServiceRestart {
  return RESTARTS.has(value);
}

/**
 * What a service's declared configuration says, in the person's terms: copies only when more than one (one copy is
 * what a service is, as the deploy review counts them), the restart policy as what it does ("on-failure:5" restarts
 * on failure), and its limits. A policy Compose may add later stays as declared.
 */
export function machineServiceDeclaredFacts(
  configuration: Pick<DeploymentReviewServiceV1, 'replicas' | 'resources' | 'restartPolicy'>,
): Readonly<{ replicas: number | null; restart: MachineServiceRestart | string | null; limits: string | null }> {
  const copies = Number(configuration.replicas);
  const policy = configuration.restartPolicy;
  const limits = [configuration.resources.cpus === null ? null : `${configuration.resources.cpus} CPU`,
    configuration.resources.memory === null ? null : String(configuration.resources.memory)].filter(Boolean);
  return {
    replicas: Number.isFinite(copies) && copies > 1 ? copies : null,
    restart: policy ? RESTART_POLICIES[policy.split(':')[0]!] ?? policy : null,
    limits: limits.length > 0 ? limits.join(' · ') : null,
  };
}

export type MachineServiceConfigurationEntry = Readonly<{ value: string; note: string | null }>;
export type MachineServiceConfigurationRow = Readonly<{
  key: 'image' | 'command' | 'ports' | 'networks' | 'mounts' | 'healthCheck' | 'variables';
  label: string;
  entries: readonly MachineServiceConfigurationEntry[];
}>;
type ConfigurationDetail = NonNullable<MachineServiceNativeRuntimeFactsV1['configurationDetails']>[number];

/** Docker's short form of an ID: its algorithm and first 12 hex digits. */
function shortImageId(digest: string): string {
  const [algorithm, hex] = digest.includes(':') ? digest.split(':', 2) as [string, string] : ['', digest];
  return `${algorithm ? `${algorithm}:` : ''}${hex.slice(0, 12)}`;
}

/** A health check's test as written: the command after CMD / CMD-SHELL; NONE turns the image's own check off. */
function healthTest(test: readonly string[]): string | null {
  const [kind, ...rest] = test;
  if (kind === 'NONE' || test.length === 0) return null;
  return kind === 'CMD' || kind === 'CMD-SHELL' ? rest.join(' ') : test.join(' ');
}

/** Distinct entries in order: replicas of one service report the same configuration once. */
function distinct(entries: readonly (MachineServiceConfigurationEntry | null)[]): readonly MachineServiceConfigurationEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry): entry is MachineServiceConfigurationEntry => {
    if (!entry) return false;
    const key = `${entry.value}\u0000${entry.note ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The service's Configuration section (pfc-redesign dCtr): what the Machine reports it was started with, each entry as
 * its value with what qualifies it beneath, in the lab's order. The compose-level facts (ports, mounts, whether a health
 * check exists) come from `configuration`; what each container runs (image and its local image ID, command, networks,
 * the health check's test and interval, variable names) from `details`, when the Machine reports them. A row the
 * Machine reports nothing for is left out; nothing here is a variable value.
 */
export function machineServiceConfigurationRows(
  configuration: Pick<DeploymentReviewServiceV1, 'ports' | 'mounts' | 'healthcheck'>,
  details: readonly ConfigurationDetail[] = [],
): readonly MachineServiceConfigurationRow[] {
  const s = 'machineServices.configuration' as const;
  const none: readonly MachineServiceConfigurationEntry[] = [{ value: t(`${s}.none`), note: null }];
  const reported = details.length > 0;
  const ports = configuration.ports.map((port): MachineServiceConfigurationEntry => ({
    value: `${port.target ?? '?'}${port.protocol ? `/${port.protocol}` : ''}`,
    note: port.published === null ? t(`${s}.notPublished`)
      : t(`${s}.publishedOn`, { address: `${port.bindAddress ?? '0.0.0.0'}:${port.published}` }),
  }));
  const mounts = configuration.mounts.map((mount): MachineServiceConfigurationEntry => {
    // A mount with no named source is named by its kind, so its kind isn't said twice.
    const note = [mount.source !== null ? mount.type : null, mount.readOnly ? t(`${s}.readOnly`) : null].filter(Boolean).join(' · ');
    return { value: `${mount.source ?? mount.type ?? '?'} → ${mount.target ?? '?'}`, note: note || null };
  });
  const images = distinct(details.map((detail) => detail.image === null ? null
    : { value: detail.image, note: detail.imageDigest ? t(`${s}.imageId`, { id: shortImageId(detail.imageDigest) }) : null }));
  const commands = distinct(details.map((detail) => detail.command && detail.command.length > 0
    ? { value: detail.command.join(' '), note: null } : null));
  // The networks it joined, or its network mode where it joined none by name (host, none); observed, not who reaches it.
  const networks = distinct(details.map((detail) => detail.networks && detail.networks.length > 0
    ? { value: detail.networks.join(' · '), note: detail.networkMode && !detail.networks.includes(detail.networkMode)
      && detail.networkMode !== 'default' && detail.networkMode !== 'bridge' ? t(`${s}.networkMode`, { mode: detail.networkMode }) : null }
    : detail.networkMode ? { value: t(`${s}.networkMode`, { mode: detail.networkMode }), note: null } : null));
  // A test the container reports says what it runs; a zero interval is Docker's inherited default and isn't said.
  const checks = distinct(details.map((detail) => {
    if (!detail.healthcheck) return null;
    const test = healthTest(detail.healthcheck.test);
    if (test === null) return { value: t(`${s}.healthAbsent`), note: null };
    const seconds = detail.healthcheck.intervalNs ? Math.round(detail.healthcheck.intervalNs / 1_000_000_000) : 0;
    return { value: test, note: seconds > 0
      ? t(`${s}.healthEvery`, { interval: t('machineVitals.monitoring.seconds', { count: seconds }) }) : null };
  }));
  const variables = distinct(details.map((detail) => detail.variableNames === null ? null
    : detail.variableNames.length > 0 ? { value: detail.variableNames.join(' · '), note: t(`${s}.namesOnly`) } : none[0]!));
  const rows: (MachineServiceConfigurationRow | null)[] = [
    images.length > 0 ? { key: 'image', label: t(`${s}.image`), entries: images } : null,
    commands.length > 0 ? { key: 'command', label: t(`${s}.command`), entries: commands } : null,
    { key: 'ports', label: t(`${s}.ports`), entries: ports.length > 0 ? ports : none },
    networks.length > 0 ? { key: 'networks', label: t(`${s}.networks`), entries: networks } : null,
    { key: 'mounts', label: t(`${s}.mounts`), entries: mounts.length > 0 ? mounts : none },
    { key: 'healthCheck', label: t(`${s}.healthCheck`), entries: checks.length > 0 ? checks
      : [{ value: t(configuration.healthcheck === 'configured' ? `${s}.healthConfigured` : `${s}.healthAbsent`), note: null }] },
    reported && variables.length > 0 ? { key: 'variables', label: t(`${s}.variables`), entries: variables } : null,
  ];
  return rows.filter((row): row is MachineServiceConfigurationRow => row !== null);
}

export type MachineServiceWatchChoice = Readonly<{
  candidateId: string; revision: string; name: string; kind: string; nativeResourceId: string;
  /** The line a person can read for this identity; a Compose tuple has none and stays an operand. */
  identityLine: string | null;
  phase: MachineServiceDiscoveryCandidateV1['observation']['phase'];
  /** Already on this page as a watched service: shown, never picked twice. */
  watched: boolean;
}>;

/** Present the producer's name resolution; native identity stays on its own line. */
export function machineServiceDisplayName(service: Pick<MachineServiceRowV1, 'name' | 'nameResolution'>): string {
  return service.nameResolution === 'unresolved_environment' ? t('machineServices.unresolvedEnvironment') : service.name;
}

/**
 * What the Machine found that the person can watch (lab `services/watch`), by kind then name. A candidate whose
 * native instance a listed row already watches is held back, matched by the protocol's one native identity key.
 */
export function machineServiceWatchChoices(
  candidates: readonly MachineServiceDiscoveryCandidateV1[],
  rows: readonly Pick<MachineServiceRowV1, 'nativeInstance'>[],
): readonly MachineServiceWatchChoice[] {
  const watched = new Set(rows.flatMap(row => row.nativeInstance ? [machineServiceNativeIdentityKeyV1(row.nativeInstance)] : []));
  // An unresolved container is named only by a generated hash: nothing here lets a person choose it.
  return candidates.filter(candidate => candidate.nameResolution !== 'unresolved_environment').map((candidate): MachineServiceWatchChoice => {
    const identity = machineServiceNativeIdentityKeyV1(candidate);
    return {
      candidateId: candidate.candidateId, revision: candidate.revision, name: candidate.name,
      kind: candidate.adapter.localId, nativeResourceId: candidate.nativeResourceId,
      identityLine: candidate.adapter.localId === 'compose' ? null : candidate.nativeResourceId, phase: candidate.observation.phase,
      watched: watched.has(identity),
    };
  }).sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

/**
 * What the service's own source reported about its run (MACH-SVC-DATA): memory, a real zero kept, and how long it
 * has been up since its last start. An unknown counter stays null, never zero; a stopped service isn't up.
 */
export function machineServiceRunFacts(
  row: Pick<MachineServiceRowV1, 'state' | 'accounting'>,
  nowMs: number,
): Readonly<{ memoryBytes: number | null; upMs: number | null }> {
  const started = row.accounting?.startedAtMs;
  const down = row.state === 'stopped' || row.state === 'stopping' || row.state === 'failed';
  return {
    memoryBytes: row.accounting?.memoryBytes ?? null,
    upMs: started === undefined || down ? null : Math.max(0, nowMs - started),
  };
}

/**
 * A service the person stopped through Happier (the producer's `health.expectedDown: 'stop'`) reads as that stop,
 * quiet rather than failing (lab `services/states` "Stopped by you"): `stopping` while its health source may already
 * report it down, `stopped` once it is. A service that is up again, or a row without the expectation, keeps its state.
 */
export function machineServiceExpectedStop(
  row: Pick<MachineServiceRowV1, 'state' | 'health'>,
): 'stopping' | 'stopped' | null {
  if (row.health?.expectedDown !== 'stop') return null;
  switch (row.state) {
    case 'stopped': return 'stopped';
    case 'stopping':
    case 'unhealthy':
    case 'failed':
    case 'unknown': return 'stopping';
    default: return null;
  }
}

/** What a Machine does for an Environment beyond running its services (lab J13 role chips), in the reading order the
 * Services tab's role rows use: what it decides, then what it builds and serves. */
export const MACHINE_DEPLOYMENT_ROLES = ['controller', 'build', 'edge'] as const;
export type MachineDeploymentRole = (typeof MACHINE_DEPLOYMENT_ROLES)[number];
type RoleEnvironment = Readonly<{ environmentId: string; title: string; roles: readonly string[] }>;

/** Each role once, with the Environments it serves; runtime and data are services, which the Services tab lists. */
export function machineDeploymentRoleSummary<T extends RoleEnvironment>(
  environments: readonly T[],
): readonly Readonly<{ role: MachineDeploymentRole; environments: readonly T[] }>[] {
  return MACHINE_DEPLOYMENT_ROLES.flatMap(role => {
    const serving = environments.filter(environment => environment.roles.includes(role));
    return serving.length ? [{ role, environments: serving }] : [];
  });
}

/**
 * A failed log read's body: the cause only, beneath the "Couldn't read logs" title and beside Retry, so the state is
 * said once. An unreachable Machine is named; a cause the failure owner knows is kept; an unknown one adds nothing.
 */
export function machineServiceLogReadFailureReason(error: unknown, machine: string): string | undefined {
  const record = error !== null && typeof error === 'object' ? error as Record<string, unknown> : null;
  if (isMachineUnreachableFailureCode(record?.code ?? record?.errorCode)) {
    return t('machineServices.logs.error.machineNotAnswering', { machine });
  }
  return resolveActionExecutionErrorMessage(error, '', { safeToRetry: true }) || undefined;
}
