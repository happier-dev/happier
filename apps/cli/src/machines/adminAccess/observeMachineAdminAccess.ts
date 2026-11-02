import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { runTailscaleOperatorObservation } from '@happier-dev/cli-common/tailscale';
import type { MachineAdminAccessObservationV1 } from '@happier-dev/protocol';
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
  const [tailscaledOperator, dropIn, accountGroups] = await Promise.all([
    readOperator(daemonUsername),
    platform === 'linux' ? observeManagedDropIn(dependencies, daemonUsername) : unsupportedDropIn,
    platform === 'linux' && daemonUsername ? readId('-Gn', daemonUsername) : null,
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
    version: 1, observedAt: Date.now(), daemonUid, daemonUsername, daemonPrimaryGroup,
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
