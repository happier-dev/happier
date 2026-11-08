import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import type { MachineAgentIsolationOwnStatusV1, MachineAgentIsolationStatusV1,
  MachineAgentIsolationProbeFailureV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import type { AgentIsolationEffectDependencies } from './agentIsolationProvisioner';
import type { HostAgentIsolationLaunchContext } from './agentIsolationLaunchPolicy';
import type { SessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { logger } from '@/ui/logger';
import { createUnixAgentIdentityLaunch } from './unixAgentIdentityAdapter';
import { readAgentIsolationNativeIdentity, type AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';

/** Explicit launch preparation may qualify a successor's unknown shared-user
 * fact. Reads never call this port, and classified failures remain terminal. */
export function createAgentIsolationNativeReadinessQualification(input: Readonly<{
  read: HostAgentIsolationLaunchContext['read'];
  effects: AgentIsolationEffectDependencies;
}>): NonNullable<HostAgentIsolationLaunchContext['qualifyNativeReadiness']> {
  return async ({ requesterIdentity, signal }) => {
    signal?.throwIfAborted();
    const snapshot = input.read();
    const effects = input.effects;
    if (requesterIdentity?.kind !== 'isolated' || !snapshot
      || resolveMachineAgentExecutionPlacementV1({ policy: snapshot, platform: effects.platform }) !== 'sharedAgent') return;
    const qualified = await observeUnqualifiedAgentIsolationNativeReadiness({ snapshot, effects, signal });
    if (!qualified) return;
    signal?.throwIfAborted();
    await effects.publishStatus(qualified);
  };
}

/** Startup restores only the incumbent native proof. It never changes policy,
 * provisions a member, reapplies setup, or retires a predecessor Session. */
export async function observeUnqualifiedAgentIsolationNativeReadiness(input: Readonly<{
  snapshot: ReturnType<HostAgentIsolationLaunchContext['read']>;
  effects: AgentIsolationEffectDependencies;
  signal?: AbortSignal;
}>): Promise<MachineAgentIsolationStatusV1 | undefined> {
  const { snapshot, effects, signal } = input;
  const status = snapshot?.status;
  if (!snapshot?.enabled || status?.kind !== 'unavailable' || status.code !== 'provisioning_unavailable'
    || status.setup || status.prerequisite || status.probeFailure || !effects.nativeReadiness) return;
  const roots = effects.readRoots();
  if (!roots) return;
  return observeAgentIsolationNativeReadiness({ installedCli: effects.installedCli,
    roots: roots.map(root => root.path), privateRoots: effects.nativeReadiness.privateRoots,
    system: effects.nativeReadiness.system, signal });
}

export type AgentIsolationReadinessSystem = Readonly<{ run: typeof execFileWithDeadline }>;
type Unavailable = Extract<MachineAgentIsolationStatusV1, { kind: 'unavailable' }>;

const probeExits = { uid: 71, umask: 72, managed_payload: 73, groups: 74, mcp_authentication: 75,
  workspace: 76, home: 77, user: 78, required_groups: 79, agent_payload: 80, root_sudo: 81,
  docker_socket: 82, private_path: 83, mcp_anonymous: 85 } as const satisfies
  Partial<Record<MachineAgentIsolationProbeFailureV1['check'], number>> & { required_groups: number };
function probeFailure(identity: MachineAgentIsolationProbeFailureV1['identity'], error: unknown): MachineAgentIsolationProbeFailureV1 {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 0) {
    const check = Object.entries(probeExits).find(([, exit]) => exit === code)?.[0] as keyof typeof probeExits | undefined;
    return { check: check === 'required_groups' ? 'groups' : check ?? 'launch', exitCode: code, identity };
  }
  const signal = error && typeof error === 'object' ? Reflect.get(error, 'signal') : undefined;
  return { check: 'launch', identity, transportError: signal ? 'signalled'
    : code === 'ENOENT' || code === 'EACCES' ? 'spawn_failed' : 'execution_failed' };
}
function probeUnavailable(failure: MachineAgentIsolationProbeFailureV1): Unavailable {
  const check = failure.check;
  return { kind: 'unavailable', code: check === 'managed_payload' || check === 'agent_payload' ? 'payload_not_accessible'
    : check === 'mcp_authentication' || check === 'mcp_anonymous' ? 'mcp_socket_access_unavailable'
    : check === 'workspace' ? 'workspace_not_ready'
    : (check === 'groups' && !('exitCode' in failure && failure.exitCode === probeExits.required_groups))
      || check === 'root_sudo' || check === 'docker_socket' || check === 'private_path'
      ? 'local_admin_api_accessible' : 'launch_probe_failed', probeFailure: failure };
}

// This fixed host-authored program runs only through the incumbent framed
// RunAs shim. No Workspace/provider command or custodian environment is read.
const nativeLaunchChecks = `[ "$(id -u)" = "$1" ] && [ "$1" != 0 ] || exit ${probeExits.uid}
[ "$HOME" = "$2" ] || exit ${probeExits.home}
[ "$USER" = "$READINESS_EXPECTED_USER" ] || exit ${probeExits.user}
groups=$(id -G)
case " $groups " in *" \${READINESS_ALLOWED_GROUPS#* } "*) ;; *) exit ${probeExits.required_groups} ;; esac
for group in $groups; do
  case " $READINESS_ALLOWED_GROUPS " in *" $group "*) ;; *) exit ${probeExits.groups} ;; esac
done
case "$(umask)" in 0002|002) ;; *) exit ${probeExits.umask} ;; esac
[ -x "$3" ] && [ ! -w "$3" ] || exit ${probeExits.managed_payload}
`;

const nativeProbe = `set -eu
runtime_home=$6
private_count=$7
trap 'rm -rf -- "$runtime_home"' 0
trap 'exit 1' HUP INT TERM
${nativeLaunchChecks}
set +e
sudo -n -u root -- /usr/bin/true >/dev/null 2>&1
root_status=$?
set -e
[ "$root_status" = 1 ] || exit ${probeExits.root_sudo}
if [ -S /var/run/docker.sock ]; then
  [ ! -w /var/run/docker.sock ] || exit ${probeExits.docker_socket}
  set +e
  curl --disable --silent --show-error --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null 2>&1
  docker_status=$?
  set -e
  [ "$docker_status" = 7 ] || exit ${probeExits.docker_socket}
fi
[ ! -r "$4" ] && [ ! -w "$4" ] || exit ${probeExits.private_path}
[ "$(curl --disable --silent --show-error --unix-socket "$5" --header "@$READINESS_HEADERS" http://localhost/readiness)" = ready ] || exit ${probeExits.mcp_authentication}
[ "$(curl --disable --silent --show-error --unix-socket "$5" --output /dev/null --write-out '%{http_code}' http://localhost/readiness)" = 401 ] || exit ${probeExits.mcp_anonymous}
shift 7
while [ "$private_count" -gt 0 ]; do
  [ ! -r "$1" ] && [ ! -w "$1" ] || exit ${probeExits.private_path}
  shift
  private_count=$((private_count - 1))
done
for root do
  [ -r "$root/daemon" ] && [ -w "$root/daemon" ] || exit ${probeExits.workspace}
  printf agent >> "$root/daemon"
  printf agent > "$root/agent"
done
cat "$READINESS_CHALLENGE"
`;

const memberProbe = `set -eu
runtime_home=$4
trap 'rm -rf -- "$runtime_home"' 0
trap 'exit 1' HUP INT TERM
${nativeLaunchChecks}
[ "$#" -lt 6 ] || { [ -x "$5" ] && { [ "$5" = "$6" ] || [ -r "$6" ]; }; } || exit ${probeExits.agent_payload}
printf 'member-native-ready\\n'
`;

/** Explicit own-status demand only. The caller supplies its single qualified
 * native observation; this never discovers/provisions an identity or publishes
 * global effectiveness. Actual RunAs and payload access are checked as member. */
export async function observeAgentIsolationMemberLaunchReadiness(input: Readonly<{
  installedCli: string;
  memberIdentity: AgentIsolationMemberNativeIdentity;
  /** The host selects this exact Agent tuple once, before granting its launch. */
  agentCliLaunch?: Readonly<{ command: string; resolvedPath: string }>;
  signal?: AbortSignal;
  system?: AgentIsolationReadinessSystem;
}>): Promise<Readonly<{ kind: 'member_native_ready';
  status: Extract<MachineAgentIsolationOwnStatusV1, { protection: 'member_separated' }>['status'];
  directories: NonNullable<Extract<MachineAgentIsolationOwnStatusV1, { protection: 'member_separated' }>['directories']> }> | Unavailable> {
  const unavailable = (code: Unavailable['code']): Unavailable => ({ kind: 'unavailable', code });
  if (process.platform !== 'linux') return unavailable('unsupported_platform');
  input.signal?.throwIfAborted();
  const identity = input.memberIdentity;
  const selected = { username: identity.username, uid: identity.agentUid, gid: identity.agentGid,
    home: identity.home, cwd: identity.home };
  const runtimeHome = join(identity.home, 'runtime', `readiness-${randomUUID()}`);
  try {
    // The existing framed shim creates the private operation runtime home. Its
    // controlled finite shell and material-finally own cleanup as that member.
    const launch = createUnixAgentIdentityLaunch({ managedHappierBinaryPath: input.installedCli,
      memberIdentity: identity, executable: '/bin/sh',
      args: ['-c', memberProbe, 'happier-isolation-readiness', String(identity.agentUid), identity.home,
        input.installedCli, runtimeHome,
        ...(input.agentCliLaunch ? [input.agentCliLaunch.command, input.agentCliLaunch.resolvedPath] : [])], cwd: identity.home, runtimeHome,
      environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', READINESS_EXPECTED_USER: identity.username,
        READINESS_ALLOWED_GROUPS: String(identity.agentGid) },
      selectedEnvironmentKeys: ['READINESS_EXPECTED_USER', 'READINESS_ALLOWED_GROUPS'], selectedMaterials: [] });
    const result = await (input.system?.run ?? execFileWithDeadline)(launch.command, launch.args,
      { env: launch.env, inputBytes: launch.stdinPreamble, signal: input.signal, terminateOnAbort: terminateProcessTree });
    input.signal?.throwIfAborted();
    return Buffer.from(result.stdout).equals(Buffer.from('member-native-ready\n'))
      ? { kind: 'member_native_ready', status: { kind: 'effective', platform: 'linux' },
        directories: { home: identity.home, workspace: identity.workspaceRoot } } : probeUnavailable({ check: 'output', exitCode: 0, identity: selected });
  } catch (error) {
    input.signal?.throwIfAborted();
    return probeUnavailable(probeFailure(selected, error));
  }
}

/** Finite native qualification, demanded by startup, explicit CHECK or Apply. No Session is invented: this
 * endpoint has no tools or Account authority and retires before publication.
 * Actual Sessions still supply their own live MCP/materialization lease. */
export async function observeAgentIsolationNativeReadiness(input: Readonly<{
  installedCli: string;
  roots: readonly string[];
  privateRoots: readonly string[];
  signal?: AbortSignal;
  system?: AgentIsolationReadinessSystem;
}>): Promise<MachineAgentIsolationStatusV1> {
  const unavailable = (code: Unavailable['code']): Unavailable => ({ kind: 'unavailable', code });
  if (process.platform !== 'linux') return unavailable('unsupported_platform');
  if (!process.getuid?.()) return unavailable('provisioning_unavailable');
  input.signal?.throwIfAborted();
  const run = input.system?.run ?? execFileWithDeadline;
  let identity: { uid: number; home: string; groups: readonly number[] };
  try {
    const { agentUid: uid, agentGid: gid, home } = await readAgentIsolationNativeIdentity(input.signal, run);
    const primary = String((await run('getent', ['--service=files', 'group', 'happier-agent'], { encoding: 'utf8', signal: input.signal })).stdout).trim().split(':');
    const group = String((await run('getent', ['--service=files', 'group', 'happier-workspace'], { encoding: 'utf8', signal: input.signal })).stdout).trim().split(':');
    const workspaceGid = Number(group[2]);
    if (!Number.isSafeInteger(gid) || gid <= 0
      || primary.length !== 4 || primary[0] !== 'happier-agent' || Number(primary[2]) !== gid
      || group.length !== 4 || group[0] !== 'happier-workspace' || !Number.isSafeInteger(workspaceGid) || workspaceGid <= 0) return unavailable('agent_user_missing');
    identity = { uid, home, groups: [gid, workspaceGid] };
  } catch { input.signal?.throwIfAborted(); return unavailable('agent_user_missing'); }
  let transport: SessionMcpLocalTransport | undefined;
  const scratch: { path: string; directory: FileHandle }[] = [];
  let authenticated = false, anonymousDenied = false;
  const server = createServer((request, response) => {
    if (!transport?.authenticate(request.headers.authorization)) {
      anonymousDenied = true; response.writeHead(401).end(); return;
    }
    authenticated = true; response.end('ready');
  });
  let phase: Unavailable['code'] = 'mcp_socket_access_unavailable';
  let selected: MachineAgentIsolationProbeFailureV1['identity'] | undefined;
  let observed: MachineAgentIsolationStatusV1;
  let cleanupFailure: Unavailable['code'] | undefined;
  const qualify = async (): Promise<MachineAgentIsolationStatusV1> => {
    // Only finite native qualification loads the transport/client graph.
    const { prepareSessionMcpLocalTransport } = await import('@/mcp/runtime/sessionMcpLocalTransport');
    transport = await prepareSessionMcpLocalTransport({ agentUid: identity.uid });
    await transport.listen(server);
    const context = transport.localContext;
    if (!context) return unavailable(phase);
    const privateFile = join(dirname(context.socketPath), 'daemon-private');
    await writeFile(privateFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    phase = 'workspace_not_ready';
    for (const root of input.roots) {
      const path = await mkdtemp(join(root, '.happier-isolation-probe-'));
      scratch.push({ path, directory: await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) });
      await chmod(path, 0o2770);
      await writeFile(join(path, 'daemon'), 'daemon', { mode: 0o660, flag: 'wx' });
    }
    phase = 'launch_probe_failed';
    const runtimeHome = join(identity.home, 'runtime', `readiness-${randomUUID()}`);
    const challenge = randomBytes(64);
    const launch = createUnixAgentIdentityLaunch({ managedHappierBinaryPath: input.installedCli,
      executable: '/bin/sh', args: ['-c', nativeProbe, 'happier-isolation-readiness', String(identity.uid), identity.home,
        input.installedCli, privateFile, context.socketPath, runtimeHome, String(input.privateRoots.length),
        ...input.privateRoots, ...scratch.map(entry => entry.path)], cwd: input.roots[0] ?? '/srv/happier', runtimeHome,
      environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', READINESS_HEADERS: join(runtimeHome, 'files/headers'),
        READINESS_CHALLENGE: join(runtimeHome, 'files/challenge'), READINESS_ALLOWED_GROUPS: identity.groups.join(' '),
        READINESS_EXPECTED_USER: 'happier-agent' },
      selectedEnvironmentKeys: ['READINESS_HEADERS', 'READINESS_CHALLENGE', 'READINESS_ALLOWED_GROUPS', 'READINESS_EXPECTED_USER'],
      selectedMaterials: [{ relativePath: 'files/headers', contentBase64: Buffer.from(`Authorization: Bearer ${context.bearerToken}\n`).toString('base64') },
        { relativePath: 'files/challenge', contentBase64: challenge.toString('base64') }], sessionMcpContext: context });
    selected = { username: 'happier-agent', uid: identity.uid, gid: identity.groups[0]!, home: identity.home,
      cwd: input.roots[0] ?? '/srv/happier' };
    const result = await run(launch.command, launch.args, { encoding: null, env: launch.env, inputBytes: launch.stdinPreamble,
      signal: input.signal, terminateOnAbort: terminateProcessTree });
    if (!Buffer.from(result.stdout).equals(challenge)) return probeUnavailable({ check: 'output', exitCode: 0, identity: selected });
    if (!authenticated || !anonymousDenied) return probeUnavailable({ check: !authenticated ? 'mcp_authentication' : 'mcp_anonymous',
      exitCode: 0, identity: selected });
    for (const entry of scratch) {
      // Agent-writable names cannot grant the daemon authority over a symlink
      // or replaced ancestor. Pin our own directory and open only regular files.
      for (const [name, expected] of [['daemon', 'daemonagent'], ['agent', 'agent']] as const) {
        const file = await open(`/proc/self/fd/${entry.directory.fd}/${name}`, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!(await file.stat()).isFile() || await file.readFile('utf8') !== expected) return probeUnavailable({
            check: 'workspace', exitCode: 0, identity: selected });
          if (name === 'agent') await file.appendFile('daemon');
        } finally { await file.close(); }
      }
    }
    input.signal?.throwIfAborted();
    return { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' };
  };
  try {
    observed = await qualify();
  } catch (error) {
    input.signal?.throwIfAborted();
    observed = selected ? probeUnavailable(probeFailure(selected, error)) : unavailable(phase);
  } finally {
    server.closeAllConnections();
    const cleanup = await Promise.allSettled([new Promise<void>(resolve => server.close(() => resolve())),
      transport?.retire(), ...scratch.map(async entry => {
      try {
        const [held, current] = await Promise.all([entry.directory.stat(), lstat(entry.path)]);
        if (held.dev !== current.dev || held.ino !== current.ino || !current.isDirectory() || current.isSymbolicLink()) {
          throw new Error('agent_isolation_probe_cleanup_failed');
        }
        await rm(entry.path, { recursive: true, force: true });
      } finally { await entry.directory.close(); }
    })]);
    for (const [index, result] of cleanup.entries()) {
      if (result.status !== 'rejected') continue;
      cleanupFailure = index < 2 ? 'mcp_socket_access_unavailable' : 'workspace_not_ready';
      // Keep cleanup observable without disclosing paths, native output or
      // replacing the original refusal/cancellation with a cleanup exception.
      logger.warn('[AGENT ISOLATION] Native readiness cleanup failed', {
        code: 'agent_isolation_probe_cleanup_failed', phase: index < 2 ? 'transport' : 'workspace',
      });
    }
  }
  input.signal?.throwIfAborted();
  return observed.kind === 'effective' && cleanupFailure ? unavailable(cleanupFailure) : observed;
}
