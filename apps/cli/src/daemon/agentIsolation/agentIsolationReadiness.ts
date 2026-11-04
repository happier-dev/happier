import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import type { MachineAgentIsolationOwnStatusV1, MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import type { SessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { logger } from '@/ui/logger';
import { createUnixAgentIdentityLaunch } from './unixAgentIdentityAdapter';
import { readAgentIsolationNativeIdentity, type AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';

export type AgentIsolationReadinessSystem = Readonly<{ run: typeof execFileWithDeadline }>;
type Unavailable = Extract<MachineAgentIsolationStatusV1, { kind: 'unavailable' }>;

/** Noninteractive authorization for the fixed member shim, without executing
 * a payload or reading privileged sudoers bytes. This is effective permission,
 * not an assertion that the managed rule's file content is unchanged. */
export async function hasAgentIsolationMemberRunAsPermission(input: Readonly<{
  installedCli: string;
  memberIdentity: AgentIsolationMemberNativeIdentity;
  signal?: AbortSignal;
  system?: AgentIsolationReadinessSystem;
}>): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  input.signal?.throwIfAborted();
  try {
    await (input.system?.run ?? execFileWithDeadline)('sudo', [
      '-n', '-l', '-u', input.memberIdentity.username, '--', input.installedCli, 'agent-launch',
    ], { env: {}, signal: input.signal, terminateOnAbort: terminateProcessTree });
    input.signal?.throwIfAborted();
    return true;
  } catch {
    input.signal?.throwIfAborted();
    return false;
  }
}

// This fixed host-authored program runs only through the incumbent framed
// RunAs shim. No Workspace/provider command or custodian environment is read.
const nativeLaunchChecks = `[ "$(id -u)" = "$1" ] && [ "$1" != 0 ] || exit 71
[ "$HOME" = "$2" ] && [ "$USER" = "$READINESS_EXPECTED_USER" ] || exit 71
groups=$(id -G)
case " $groups " in *" \${READINESS_ALLOWED_GROUPS#* } "*) ;; *) exit 71 ;; esac
for group in $groups; do
  case " $READINESS_ALLOWED_GROUPS " in *" $group "*) ;; *) exit 74 ;; esac
done
case "$(umask)" in 0002|002) ;; *) exit 72 ;; esac
[ -x "$3" ] && [ ! -w "$3" ] || exit 73
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
[ "$root_status" = 1 ] || exit 74
if [ -S /var/run/docker.sock ]; then
  [ ! -w /var/run/docker.sock ] || exit 74
  set +e
  curl --disable --silent --show-error --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null 2>&1
  docker_status=$?
  set -e
  [ "$docker_status" = 7 ] || exit 74
fi
[ ! -r "$4" ] && [ ! -w "$4" ] || exit 74
[ "$(curl --disable --silent --show-error --unix-socket "$5" --header "@$READINESS_HEADERS" http://localhost/readiness)" = ready ] || exit 75
[ "$(curl --disable --silent --show-error --unix-socket "$5" --output /dev/null --write-out '%{http_code}' http://localhost/readiness)" = 401 ] || exit 75
shift 7
while [ "$private_count" -gt 0 ]; do
  [ ! -r "$1" ] && [ ! -w "$1" ] || exit 74
  shift
  private_count=$((private_count - 1))
done
for root do
  [ -r "$root/daemon" ] && [ -w "$root/daemon" ] || exit 76
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
[ "$#" -lt 6 ] || { [ -x "$5" ] && { [ "$5" = "$6" ] || [ -r "$6" ]; }; } || exit 73
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
        directories: { home: identity.home, workspace: identity.workspaceRoot } } : unavailable('launch_probe_failed');
  } catch (error) {
    input.signal?.throwIfAborted();
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return unavailable(code === 73 ? 'payload_not_accessible'
      : code === 74 ? 'local_admin_api_accessible' : 'launch_probe_failed');
  }
}

/** Finite native qualification, demanded by explicit CHECK or Apply. No Session is invented: this
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
  let observed: MachineAgentIsolationStatusV1;
  let cleanupFailure: Unavailable['code'] | undefined;
  const qualify = async (): Promise<MachineAgentIsolationStatusV1> => {
    // Explicit demand owns loading the transport/client graph, not daemon startup.
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
    const result = await run(launch.command, launch.args, { encoding: null, env: launch.env, inputBytes: launch.stdinPreamble,
      signal: input.signal, terminateOnAbort: terminateProcessTree });
    if (!Buffer.from(result.stdout).equals(challenge)) return unavailable(phase);
    if (!authenticated || !anonymousDenied) return unavailable('mcp_socket_access_unavailable');
    for (const entry of scratch) {
      // Agent-writable names cannot grant the daemon authority over a symlink
      // or replaced ancestor. Pin our own directory and open only regular files.
      for (const [name, expected] of [['daemon', 'daemonagent'], ['agent', 'agent']] as const) {
        const file = await open(`/proc/self/fd/${entry.directory.fd}/${name}`, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!(await file.stat()).isFile() || await file.readFile('utf8') !== expected) return unavailable('workspace_not_ready');
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
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    observed = unavailable(code === 75 ? 'mcp_socket_access_unavailable' : code === 76 ? 'workspace_not_ready'
      : code === 73 ? 'payload_not_accessible' : code === 74 ? 'local_admin_api_accessible' : phase);
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
