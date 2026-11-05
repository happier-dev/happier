import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { runTailscaleOperatorObservation } from '@happier-dev/cli-common/tailscale';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from '@happier-dev/cli-common/machineSetup';
import { readSystemdUnitStatus } from '@happier-dev/cli-common/service/discovery';
import type { MachineAdminAccessObservationV1 } from '@happier-dev/protocol';
import { readUnifiedProcessCgroupRelativePath } from '@/daemon/platform/linux/readUnifiedProcessCgroupRelativePath';
import { MANAGED_SUDOERS_PATH, recognizeManagedSudoersDropIn } from './managedSudoers';

export type MachineAdminAccessNativeDependencies = Readonly<{
  platform?: NodeJS.Platform;
  execFile?: (file: string, args: readonly string[]) => Promise<Readonly<{ stdout: string }>>;
  fileSystem?: Readonly<{
    lstat: (path: string) => Promise<Pick<Stats, 'uid' | 'gid' | 'mode' | 'isFile' | 'isSymbolicLink'>>;
    readFile: (path: string, encoding: 'utf8') => Promise<string>;
  }>;
  readTailscaledOperator?: () => Promise<MachineAdminAccessObservationV1['tailscaledOperator']>;
  tailscale?: Readonly<{ tailscaleBin?: string; socketPath?: string }>;
}>;

// Linux rootful-engine groups are host authority, independent of desired admin mode.
const ROOT_EQUIVALENT_GROUPS = new Set(['docker', 'lxd', 'libvirt']);

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

async function observeDaemonAccount(dependencies: MachineAdminAccessNativeDependencies, daemonUsername: string | null,
  daemonUid: number | null): Promise<NonNullable<MachineAdminAccessObservationV1['daemonAccount']>> {
  const unknown = { passwordLocked: null, loginShell: null };
  if ((dependencies.platform ?? process.platform) !== 'linux' || !daemonUsername || daemonUid === null) return unknown;
  try {
    // Reuse the setup owner's local account and passwd-status interpretation, without applying any effect.
    const execute = dependencies.execFile;
    const backend = createMachineSetupNativeBackend({ platform: 'linux', ...(execute ? {
      run: async (command: MachineSetupNativeCommand) => {
        try { return { code: 0, stdout: (await execute(command.executable, command.args)).stdout, stderr: '' }; }
        catch (error) { const code = errorCode(error); return { code: typeof code === 'number' ? code : null, stdout: '', stderr: '',
          ...(typeof code === 'string' ? { errorCode: code } : {}) }; }
      },
    } : {}) });
    const account = await backend.observe({ id: 'daemon-account', kind: 'user', username: daemonUsername, uid: daemonUid, locked: true });
    if (account.reason === 'foreign_effect_conflict') return unknown;
    const { facts } = account;
    return { passwordLocked: typeof facts.locked === 'boolean' ? facts.locked : null,
      loginShell: typeof facts.shell === 'string' ? facts.shell : null };
  } catch { return unknown; }
}

async function observeDaemonService(dependencies: MachineAdminAccessNativeDependencies, daemonUid: number | null,
  execute: NonNullable<MachineAdminAccessNativeDependencies['execFile']>): Promise<NonNullable<MachineAdminAccessObservationV1['daemonService']>> {
  const unknown = { mode: null, startsAtBoot: null };
  if ((dependencies.platform ?? process.platform) !== 'linux') return unknown;
  const cgroup = await readUnifiedProcessCgroupRelativePath(process.pid, '/proc', dependencies.fileSystem?.readFile);
  const parts = cgroup?.split('/') ?? [];
  const unit = parts.at(-1);
  if (!unit?.endsWith('.service')) return unknown;
  const mode = daemonUid !== null && parts.includes(`user@${daemonUid}.service`) ? 'user'
    : parts[1] === 'system.slice' ? 'system' : null;
  if (!mode) return unknown;
  try {
    const { stdout } = await execute('systemctl', [...(mode === 'user' ? ['--user'] : []), 'show',
      '--property=LoadState', '--property=UnitFileState', '--', unit]);
    const status = readSystemdUnitStatus({ output: stdout });
    if (status.loadState !== 'loaded') return { mode, startsAtBoot: null };
    // Non-enabled units can still be dependency-started. Do not infer a negative boot fact.
    if (status.unitFileState !== 'enabled') return { mode, startsAtBoot: null };
    if (mode === 'system') return { mode, startsAtBoot: true };
    // Automatic user-manager boot without signing in needs linger as well as enablement.
    const linger = (await execute('loginctl', ['show-user', String(daemonUid), '--property=Linger', '--value'])).stdout.trim();
    return { mode, startsAtBoot: linger === 'yes' ? true : linger === 'no' ? false : null };
  } catch { return { mode, startsAtBoot: null }; }
}

async function observeManagedDropIn(dependencies: MachineAdminAccessNativeDependencies, daemonUsername: string | null): Promise<Readonly<{
  state: MachineAdminAccessObservationV1['managedDropIn'];
  reasonCode?: MachineAdminAccessObservationV1['reasonCode'];
}>> {
  const fileSystem = dependencies.fileSystem ?? { lstat, readFile };
  try {
    const stat = await fileSystem.lstat(MANAGED_SUDOERS_PATH);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o440) {
      return { state: 'invalid', reasonCode: 'dropInInvalid' };
    }
    const content = await fileSystem.readFile(MANAGED_SUDOERS_PATH, 'utf8');
    if (!daemonUsername) return { state: 'unknown', reasonCode: 'observationFailed' };
    // The effect builder owns exact byte recognition; observation never invents sudoers grammar.
    const state = recognizeManagedSudoersDropIn(content, daemonUsername);
    return { state, ...(state === 'invalid' ? { reasonCode: 'dropInInvalid' as const } : {}) };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { state: 'absent' };
    return { state: 'unknown', reasonCode: code === 'EACCES' || code === 'EPERM' ? 'needs_admin_to_check' : 'observationFailed' };
  }
}

export async function observeMachineAdminAccess(dependencies: MachineAdminAccessNativeDependencies = {}): Promise<MachineAdminAccessObservationV1> {
  const platform = dependencies.platform ?? process.platform;
  const execute = dependencies.execFile ?? (async (file: string, args: readonly string[]) => {
    const result = await execFileWithDeadline(file, args, { encoding: 'utf8' });
    return { stdout: String(result.stdout) };
  });
  const readId = async (argument: string, user?: string) => {
    try { return (await execute('id', user === undefined ? [argument] : [argument, '--', user])).stdout.trim(); } catch { return null; }
  };
  const readRootSudo = async (): Promise<MachineAdminAccessObservationV1['passwordlessSudoToRoot']> => {
    if (platform !== 'linux') return 'unknown';
    try {
      await execute('sudo', ['-n', '-u', 'root', 'true']);
      return 'allowed';
    } catch (error) {
      const code = errorCode(error);
      return code === 'ENOENT' ? 'unavailable' : code === 1 ? 'denied' : 'unknown';
    }
  };
  const readOperator = async (daemonUsername: string | null): Promise<MachineAdminAccessObservationV1['tailscaledOperator']> => {
    try {
      if (dependencies.readTailscaledOperator) return await dependencies.readTailscaledOperator();
      if (platform !== 'linux') return { authorization: 'unknown' };
      return await runTailscaleOperatorObservation({ ...dependencies.tailscale, daemonUsername }, dependencies.execFile ? {
        runCommand: async request => {
          const result = await execute(request.command, request.args);
          return { command: request.command, args: request.args, exitCode: 0, stdout: result.stdout, stderr: '' };
        },
      } : {});
    }
    catch { return { authorization: 'unknown' }; }
  };
  const unix = platform === 'linux' || platform === 'darwin';
  const unsupportedDropIn: Awaited<ReturnType<typeof observeManagedDropIn>> = { state: 'unknown' };
  const [uid, username, primaryGroup, groups, passwordlessSudoToRoot] = await Promise.all([
    unix ? readId('-u') : null,
    unix ? readId('-un') : null,
    unix ? readId('-gn') : null,
    platform === 'linux' ? readId('-Gn') : null,
    readRootSudo(),
  ]);
  const numericUid = uid !== null && /^\d+$/.test(uid) ? Number(uid) : null;
  const daemonUid = numericUid !== null && Number.isSafeInteger(numericUid) ? numericUid : null;
  const daemonUsername = username && !/\s/.test(username) ? username : null;
  const daemonPrimaryGroup = primaryGroup && /^[a-z_][a-z0-9_.-]*[$]?$/i.test(primaryGroup) ? primaryGroup : null;
  const [tailscaledOperator, dropIn, accountGroups, daemonAccount, daemonService] = await Promise.all([
    readOperator(daemonUsername),
    platform === 'linux' ? observeManagedDropIn(dependencies, daemonUsername) : unsupportedDropIn,
    platform === 'linux' && daemonUsername ? readId('-Gn', daemonUsername) : null,
    observeDaemonAccount(dependencies, daemonUsername, daemonUid),
    observeDaemonService(dependencies, daemonUid, execute),
  ]);
  const processGroupSet = groups ? new Set(groups.split(/\s+/)) : null;
  const accountGroupSet = accountGroups ? new Set(accountGroups.split(/\s+/)) : null;
  const knownRootGroups = [...new Set([...(processGroupSet ?? []), ...(accountGroupSet ?? [])])]
    .filter(group => ROOT_EQUIVALENT_GROUPS.has(group)).sort();
  // Either successful read can prove power; only both can prove its absence.
  const rootEquivalentGroups = knownRootGroups.length > 0 || (processGroupSet !== null && accountGroupSet !== null)
    ? knownRootGroups : null;
  let groupMembership: NonNullable<MachineAdminAccessObservationV1['groupMembership']> = { state: 'unknown' };
  if (processGroupSet && accountGroupSet) {
    const addedGroups = [...accountGroupSet].filter(group => !processGroupSet.has(group)).sort();
    const removedGroups = [...processGroupSet].filter(group => !accountGroupSet.has(group)).sort();
    groupMembership = addedGroups.length > 0 || removedGroups.length > 0
      ? { state: 'pendingRestart', addedGroups, removedGroups } : { state: 'current' };
  }
  const reasonCode: MachineAdminAccessObservationV1['reasonCode'] = platform !== 'linux' ? 'platformUnsupported'
    : daemonUid === 0 ? 'daemonRunningAsRoot'
    : dropIn.reasonCode ?? (passwordlessSudoToRoot === 'unavailable' ? 'sudoUnavailable'
      : daemonUid === null || daemonUsername === null || groupMembership.state === 'unknown' || passwordlessSudoToRoot === 'unknown'
        ? 'observationFailed' : undefined);
  return {
    version: 1, observedAt: Date.now(), daemonUid, daemonUsername, daemonPrimaryGroup, daemonAccount, daemonService,
    daemonIdentity: daemonUid === null ? 'unknown' : daemonUid === 0 ? 'root' : 'nonRoot',
    rootEquivalentGroups, groupMembership, passwordlessSudoToRoot, managedDropIn: dropIn.state, tailscaledOperator,
    ...(reasonCode ? { reasonCode } : {}),
  };
}

export function createMachineAdminAccessObserver(dependencies: MachineAdminAccessNativeDependencies & Readonly<{
  onChanged: (observation: MachineAdminAccessObservationV1) => Promise<void>;
}>) {
  let published: MachineAdminAccessObservationV1 | null = null;
  let pending: Promise<MachineAdminAccessObservationV1> | undefined;
  const readAndPublish = async () => {
    const observation = await observeMachineAdminAccess(dependencies);
    let next = observation;
    if (published) {
      const { observedAt: _previousTime, ...previousFacts } = published;
      const { observedAt: _nextTime, ...nextFacts } = observation;
      if (isDeepStrictEqual(previousFacts, nextFacts)) return published;
      next = { ...observation,
        rootEquivalentGroups: isDeepStrictEqual(observation.rootEquivalentGroups, published.rootEquivalentGroups)
          ? published.rootEquivalentGroups : observation.rootEquivalentGroups,
        groupMembership: isDeepStrictEqual(observation.groupMembership, published.groupMembership)
          ? published.groupMembership : observation.groupMembership,
        tailscaledOperator: isDeepStrictEqual(observation.tailscaledOperator, published.tailscaledOperator)
          ? published.tailscaledOperator : observation.tailscaledOperator,
        daemonAccount: isDeepStrictEqual(observation.daemonAccount, published.daemonAccount)
          ? published.daemonAccount : observation.daemonAccount,
        daemonService: isDeepStrictEqual(observation.daemonService, published.daemonService)
          ? published.daemonService : observation.daemonService,
      };
    }
    await dependencies.onChanged(next);
    published = next;
    return next;
  };
  return {
    read: (): MachineAdminAccessObservationV1 | null => published,
    async inspect() {
      pending ??= readAndPublish().finally(() => { pending = undefined; });
      return { observation: await pending, checkedAt: Date.now() };
    },
  };
}
