import { randomBytes } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import type { Duplex } from 'node:stream';

import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createOwnerOnlyLocalEndpoint } from '@/utils/ipc/ownerOnlyLocalEndpoint';

import { observeLocalIpcPeerIdentity, resolveProcessCustodyPeerIdentityExecutable, type ProcessCustodyPeerIdentity } from './processCustody';
import type { SessionHolderTarget } from './sessionHolder';

/**
 * The daemon→runner relay for a Session placed in a target (no daemon inside
 * the target). The daemon holds the target's managed custody and the Session
 * authority; the runner holds none. The runner reaches the target's two
 * provider operations only through this owner-only local socket, which the
 * daemon serves for the Session's lifetime:
 * - `exec`: one finite guest command, one JSON reply line, then the socket ends;
 * - `channel`: a live byte channel (the provider's `stream` role) piped both ways.
 * Each connection starts with one JSON request line. Same-OS-user processes are
 * trusted (the existing local model); the socket lives in the private holder
 * directory and is removed when the Session ends.
 */
export type SessionTargetOperations = Readonly<{
    exec(command: string, signal: AbortSignal): Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
    openChannel(argv: readonly string[], signal: AbortSignal): Duplex;
}>;

/**
 * Target-native launch facts from the daemon's launch step. Nothing of this
 * Machine's launch crosses except through them: the Agent CLI the step placed
 * in the target (host command → target path), the Agent environment rewritten
 * into the target (its delivered credential home), and the workspace root.
 */
export type SessionTargetLaunch = Readonly<{
    executables: Readonly<Record<string, string>>;
    env: Readonly<Record<string, string>>;
    workspace?: Readonly<{ hostRoot: string; targetRoot: string }>;
    /** Held shared by every Agent of the Session for its life: marks its delivered files live. */
    lockPath?: string;
    /** Digest-verified target custody helper; older issued Linux launches used external `flock`. */
    lockExecutable?: string;
}>;

/** What a target Session's runner needs to place its Agents (the runner env carries it). */
export type SessionTargetPlacement = Readonly<{
    id: string;
    holderPath: string;
    socketDirectory: string;
    relaySocketPath: string;
    /** The primary Agent's holder socket, chosen by the daemon so its Files/Git client can reach that holder. */
    primarySocketPath?: string;
    /** The digest-checked custody helper in the target: the runner's workspace operations run through it. */
    helperPath?: string;
    launch?: SessionTargetLaunch;
}>;

function targetLaunchError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

type SessionTargetWorkspace = NonNullable<SessionTargetLaunch['workspace']>;

/**
 * The one mapping between a placed Session's two names for its workspace
 * (decided once at admission by the launch step): this Machine's Session path
 * (`hostRoot`, which host machinery such as Exec admission and path policy
 * speaks) and the same workspace inside the target (`targetRoot`, the only
 * path the Agent may see: protocol cwd/workspaceRoot, launch cwd).
 */
export function toSessionTargetPath(workspace: SessionTargetWorkspace | undefined, hostPath: string): string {
    const rest = workspace ? relative(workspace.hostRoot, hostPath) : '..';
    if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
        throw targetLaunchError('workspace_root_unsafe', 'The Agent working directory is outside the Session target workspace');
    }
    return rest ? posix.join(workspace!.targetRoot, ...rest.split(sep)) : workspace!.targetRoot;
}

/** The inverse of `toSessionTargetPath`; `null` when `targetPath` is not under the target workspace. */
function toSessionHostPath(workspace: SessionTargetWorkspace, targetPath: string): string | null {
    const rest = posix.relative(workspace.targetRoot, targetPath);
    if (rest === '..' || rest.startsWith('../') || posix.isAbsolute(rest)) return null;
    return rest ? join(workspace.hostRoot, ...rest.split('/')) : workspace.hostRoot;
}

function readPlacedSessionWorkspace(): SessionTargetWorkspace | null {
    return readSessionTargetPlacement(sessionProcessEnvironment())?.launch?.workspace ?? null;
}

/**
 * The Agent-facing path of a Session path: in a placed Session the target path
 * (e.g. `/workspace/sub`), otherwise the path itself. Every value the Agent
 * receives as its workspace (open request cwd, control contexts) goes through here.
 */
export function resolveSessionAgentPath(hostPath: string): string {
    const workspace = readPlacedSessionWorkspace();
    return workspace ? toSessionTargetPath(workspace, hostPath) : hostPath;
}

/** A placed Session's skill delivery the Agent can read: the target names of its paths, or none. */
type SessionAgentSkillDelivery = Readonly<{
    pluginRoot: string;
    skillsRoot: string;
    items: readonly Readonly<{ name: string; skillId: string; digest: string; directory: string }>[];
    nativeDisables: readonly Readonly<{ name: string; path: string }>[];
}>;

/**
 * The Agent-facing form of a skill delivery (open request `skills`). Its folders are
 * materialized on this Machine; in a placed Session only paths inside the Session
 * workspace exist in the target (under their target names). A delivery whose root is
 * elsewhere is withheld (`undefined`): the Agent would read paths that do not exist there.
 */
export function resolveSessionAgentSkills<T extends SessionAgentSkillDelivery>(skills: T | undefined): T | undefined {
    const workspace = readPlacedSessionWorkspace();
    if (!skills || !workspace) return skills;
    const map = (path: string) => { try { return toSessionTargetPath(workspace, path); } catch { return null; } };
    const pluginRoot = map(skills.pluginRoot);
    const skillsRoot = map(skills.skillsRoot);
    const items = skills.items.map(item => ({ ...item, directory: map(item.directory) }));
    const nativeDisables = skills.nativeDisables.map(entry => ({ ...entry, path: map(entry.path) }));
    if (pluginRoot === null || skillsRoot === null || items.some(item => item.directory === null)
        || nativeDisables.some(entry => entry.path === null)) return undefined;
    return { ...skills, pluginRoot, skillsRoot, items, nativeDisables } as T;
}

/**
 * The host name of an Agent-facing working directory, for this Machine's Exec
 * admission (which resolves and authorizes paths on this Machine): a target
 * path under the placed workspace becomes its Session path; the holder launch
 * maps it back (`prepareTargetAgentLaunch`). Anything else is returned as is.
 */
export function resolveSessionHostCwd(cwd: string): string {
    const workspace = readPlacedSessionWorkspace();
    return workspace ? toSessionHostPath(workspace, cwd) ?? cwd : cwd;
}

/**
 * The Session MCP context file an Agent's relay (`holder mcp-relay`) reads. This
 * Machine's endpoint is a local socket nothing in a target can reach, so a placed
 * Session's Agents are named none: each relay uses the context of the holder it
 * runs under in the target (`serve --session-mcp`, found among its ancestors),
 * which admits only that holder's Agent tree and carries the connection on its
 * client channel to this runner (`sessionHolder.ts`, `M` stream). The primary
 * and every other held Agent (execution runs) reach the Session's MCP alike.
 */
export function resolveSessionAgentMcpContextFile(hostContextFile: string | undefined): string | undefined {
    return readSessionTargetPlacement(sessionProcessEnvironment()) ? undefined : hostContextFile;
}

/**
 * Admission invariant for the mapping above: the two roots are equal or
 * disjoint, so a path names one side only (a host root inside the target root,
 * or the reverse, would make `/workspace/a/x` both a host and a target path).
 */
export function assertSessionTargetWorkspaceUnambiguous(workspace: SessionTargetWorkspace): void {
    const host = workspace.hostRoot.split(sep).join('/');
    if (host === workspace.targetRoot) return;
    const nested = (outer: string, inner: string) => { const rest = posix.relative(outer, inner); return rest !== '' && rest !== '..' && !rest.startsWith('../') && !posix.isAbsolute(rest); };
    if (nested(host, workspace.targetRoot) || nested(workspace.targetRoot, host)) {
        throw targetLaunchError('workspace_root_unsafe', 'The Session path and the target workspace root must be equal or disjoint');
    }
}

/** Maps one Agent launch on this Machine to its launch in the target; refuses anything not placed there. */
export function prepareTargetAgentLaunch(launch: SessionTargetLaunch | undefined,
    request: Readonly<{ command: string; args: readonly string[]; cwd?: string }>): Readonly<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<Record<string, string>> }> {
    const command = launch?.executables[request.command];
    if (!command) throw targetLaunchError('agent_cli_target_unavailable', 'This Agent CLI was not placed in the Session target');
    const hostCwd = request.cwd === undefined ? undefined
        : launch?.workspace ? toSessionHostPath(launch.workspace, request.cwd) ?? request.cwd : request.cwd;
    const cwd = hostCwd === undefined ? launch?.workspace?.targetRoot : toSessionTargetPath(launch?.workspace, hostCwd);
    const locked = launch?.lockPath ? launch.lockExecutable
        ? { command: launch.lockExecutable, args: ['file-lock', '-s', launch.lockPath, '--', command, ...request.args] }
        : { command: 'flock', args: ['-s', launch.lockPath, command, ...request.args] } : { command, args: request.args };
    return { ...locked,
        ...(cwd !== undefined ? { cwd } : {}), env: launch?.env ?? {} };
}

export const SESSION_TARGET_PLACEMENT_ENV_KEY = 'HAPPIER_SESSION_TARGET_PLACEMENT';

type RelayRequest = Readonly<{ op: 'exec'; command: string }> | Readonly<{ op: 'channel'; argv: readonly string[] }>;

/**
 * A request becomes one provider command line (exec) or argv (channel) in the
 * guest, which Linux bounds by ARG_MAX (2 MiB by default): a longer request
 * could never run, so the relay stops reading it there.
 */
const RELAY_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

function readRequest(socket: Socket): Promise<Readonly<{ request: RelayRequest; rest: Buffer }>> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) {
                if (buffered.byteLength > RELAY_REQUEST_MAX_BYTES) { socket.off('data', onData); reject(new Error('Session target relay request too large')); }
                return;
            }
            socket.off('data', onData);
            socket.pause();
            try {
                const parsed: unknown = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
                const request = parsed as RelayRequest;
                const valid = request && typeof request === 'object'
                    && (request.op === 'exec' && typeof request.command === 'string'
                        || request.op === 'channel' && Array.isArray(request.argv) && request.argv.length > 0
                            && request.argv.every(part => typeof part === 'string'));
                if (!valid) throw new Error('Invalid Session target relay request');
                resolve({ request, rest: buffered.subarray(newline + 1) });
            } catch (error) { reject(error); }
        };
        socket.on('data', onData);
        socket.once('error', reject);
        socket.once('end', () => reject(new Error('Session target relay request ended early')));
    });
}

/**
 * Serves the relay until `lifetime` aborts (the tracked Session ended): the
 * socket is closed and removed, and every running exec/channel is aborted.
 */
export async function serveSessionTargetRelay(input: Readonly<{
    operations: SessionTargetOperations;
    lifetime: AbortSignal;
    /** A path in a private (0700) directory; on Windows mapped to an owner-only named pipe. */
    socketPath: string;
    /** The one process admitted (the Session's runner), proven by the kernel; `null` until known: refuse. */
    readTrustedCallerPid(): number | null;
    /** Test seam for the peer-identity boundary (OS process adapter). */
    observePeer?: (socket: Socket) => Promise<ProcessCustodyPeerIdentity | null>;
}>): Promise<Readonly<{ socketPath: string }>> {
    const endpoint = createOwnerOnlyLocalEndpoint({ endpointPath: input.socketPath, windowsPipePrefix: 'happier-session-target-' });
    const observePeer = input.observePeer ?? (async (socket: Socket) => {
        const windowsPid = endpoint.peerPid(socket);
        if (windowsPid !== undefined) return { pid: windowsPid, uid: null };
        const executablePath = resolveProcessCustodyPeerIdentityExecutable(process.platform);
        return executablePath ? await observeLocalIpcPeerIdentity({ socket, executablePath }).catch(() => null) : null;
    });
    // Same rule as the local Session RPC channel: the kernel-proven peer is this OS user's expected process.
    const isTrusted = (identity: ProcessCustodyPeerIdentity | null) => {
        const trusted = input.readTrustedCallerPid();
        return identity !== null && trusted !== null && identity.pid === trusted
            && (process.platform === 'win32' || identity.uid === process.getuid?.());
    };
    const live = new Set<Socket>();
    const serve = (socket: Socket) => {
        const connection = new AbortController();
        const signal = AbortSignal.any([input.lifetime, connection.signal]);
        socket.once('close', () => connection.abort());
        socket.on('error', () => connection.abort());
        void readRequest(socket).then(async ({ request, rest }) => {
            if (request.op === 'exec') {
                const reply = await input.operations.exec(request.command, signal).then(
                    result => ({ status: result.status, stdout: result.stdout, stderr: result.stderr }),
                    (error: unknown) => ({ error: { code: (error as { code?: unknown })?.code ?? 'session_target_unavailable',
                        message: error instanceof Error ? error.message : String(error) } }));
                socket.end(`${JSON.stringify(reply)}\n`);
                return;
            }
            const channel = input.operations.openChannel(request.argv, signal);
            if (rest.length) channel.write(rest);
            socket.pipe(channel);
            channel.pipe(socket);
            socket.resume();
            // Either end closing is "channel dropped": the holder client reattaches.
            channel.once('close', () => socket.destroy());
            channel.once('error', () => socket.destroy());
            socket.once('close', () => channel.destroy());
        }, () => socket.destroy());
    };
    const server: Server = createServer(socket => {
        live.add(socket);
        socket.once('close', () => live.delete(socket));
        socket.pause();
        void observePeer(socket).then(identity => {
            if (socket.destroyed) return;
            if (!isTrusted(identity)) { socket.destroy(); return; }
            socket.resume();
            serve(socket);
        }, () => socket.destroy());
    });
    await endpoint.listen(server);
    await endpoint.secure();
    const close = () => {
        server.close();
        for (const socket of live) socket.destroy();
        void endpoint.remove();
    };
    if (input.lifetime.aborted) close();
    else input.lifetime.addEventListener('abort', close, { once: true });
    return { socketPath: endpoint.endpointPath };
}

/** The runner side: the target's two operations, reached only through the daemon's relay. */
export function connectSessionTarget(placement: SessionTargetPlacement): SessionHolderTarget {
    const open = (request: RelayRequest): Socket => {
        const socket = connect(placement.relaySocketPath);
        socket.write(`${JSON.stringify(request)}\n`);
        return socket;
    };
    return Object.freeze({
        id: placement.id,
        holderPath: placement.holderPath,
        socketDirectory: placement.socketDirectory,
        prepareLaunch: request => prepareTargetAgentLaunch(placement.launch, request),
        exec: command => new Promise((resolve, reject) => {
            const socket = open({ op: 'exec', command });
            const chunks: Buffer[] = [];
            socket.on('data', (chunk: Buffer) => chunks.push(chunk));
            socket.once('error', reject);
            socket.once('close', () => {
                try {
                    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as
                        { status: number; stdout: string; stderr: string } | { error: { code: string; message: string } };
                    if ('error' in reply) reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
                    else resolve(reply);
                } catch {
                    reject(Object.assign(new Error('The Session target relay ended without a reply'), { code: 'session_target_unavailable' }));
                }
            });
        }),
        openChannel: argv => open({ op: 'channel', argv }),
    });
}

/** A holder socket path inside the target's private socket directory. */
export function createTargetHolderSocketPath(placement: Pick<SessionTargetPlacement, 'socketDirectory'>): string {
    return posix.join(placement.socketDirectory, `${randomBytes(12).toString('hex')}.sock`);
}

/** The Session's placement handed to its runner by the daemon (null: this Machine). */
export function readSessionTargetPlacement(environment: NodeJS.ProcessEnv): SessionTargetPlacement | null {
    const raw = environment[SESSION_TARGET_PLACEMENT_ENV_KEY];
    if (raw === undefined) return null;
    const parsed: unknown = JSON.parse(raw);
    const placement = parsed as SessionTargetPlacement;
    if (!placement || typeof placement !== 'object' || ![placement.id, placement.holderPath, placement.socketDirectory, placement.relaySocketPath]
        .every(value => typeof value === 'string' && value.length > 0)) {
        throw Object.assign(new Error('The Session target placement is malformed'), { code: 'session_target_unavailable' });
    }
    return placement;
}
