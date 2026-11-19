import { ChildProcess, spawn, type SpawnOptions, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { Readable, Writable, type Duplex } from 'node:stream';
import { constants as osConstants } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { readHostedSessionScope, sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { logger } from '@/ui/logger';
import { isOwnerOnlyPath, resolveOwnerOnlySocketRoot } from '@/utils/ipc/ownerOnlyLocalEndpoint';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { execWithManagedChannelEnvironment } from '@/machines/managed/channelEnvironmentDelivery';
import { connectSessionTarget, createTargetHolderSocketPath, readSessionTargetPlacement } from './sessionTargetRelay';
import { PROCESS_TERMINATION_GRACE_MS } from './terminationPolicy';
import { resolveHolderWorkspaceCommand } from '@/workspaces/source/holderWorkspaceCommand';
import { resolveProcessCustodySupportExecutable } from './processCustody';

/**
 * Client side of the per-Session holder (`happier-session-holder`, built and
 * shipped with the iroh-native native artifacts). The holder owns the Agent's
 * stdio pipes and process group, so the Session runner can crash or be replaced
 * without ending the Agent; a later runner attaches to the same holder.
 *
 * `SessionHolderChild` is a `ChildProcess` whose pipes are carried over the
 * holder socket, so the one process supervisor and every protocol client keep
 * their existing contract. `pid` is the Agent's pid (its own process-group
 * leader), so the existing tree terminator ends the Agent exactly as before.
 *
 * State: a dropped channel means "state unknown, reattach" (`holderDisconnected`);
 * only the holder's exit frame means the Agent exited.
 *
 * Replay: each output frame carries a holder sequence number. The client
 * acknowledges a frame after its bytes were delivered to the stdout/stderr
 * consumers (which hand Agent output to the Session's own outbox); unacknowledged
 * frames are replayed to the next attachment. At most the frames delivered but
 * not yet acknowledged when a runner dies can repeat (at-least-once); consumers
 * already commit transcript items under stable ids.
 */

const FRAME_HEADER_BYTES = 5;

/**
 * Each Session's local Agent-tree roots, by the Session's hosted scope (one process can host
 * several Sessions): its holders, whose children are the Agents (each leads its own process group
 * under the holder), and the Session-owned managed service processes an Agent runs through (for
 * example an Agent server). The Session MCP endpoint admits only peers inside that tree.
 */
type SessionAgentTreeRoot = Readonly<{ holderPid?: number; pid?: number }>;
const processHolderScope = {};
const heldProcessesByScope = new WeakMap<object, Set<SessionAgentTreeRoot>>();

/** The current Session's key for `readSessionAgentTreeRoots` (the process itself outside a session host). */
export function currentSessionHolderScope(): object {
    return readHostedSessionScope() ?? processHolderScope;
}

/** Live local holder pids and Agent pids (process-group leaders) of one Session. */
export function readSessionAgentTreeRoots(scope: object): Readonly<{ holderPids: readonly number[]; agentPids: readonly number[] }> {
    const children = [...heldProcessesByScope.get(scope) ?? []];
    return {
        holderPids: children.flatMap(child => child.holderPid === undefined ? [] : [child.holderPid]),
        agentPids: children.flatMap(child => child.pid === undefined ? [] : [child.pid]),
    };
}

/**
 * A managed process this Session owns (its custody owner names the Session) roots part of the
 * Session's Agent tree until it exits, like a held Agent.
 */
export function trackSessionManagedProcess(child: Readonly<{ pid?: number }> & Pick<NodeJS.EventEmitter, 'once'>): void {
    if (child.pid === undefined) return;
    trackSessionAgentTreeRoot(Object.freeze({ pid: child.pid }), child);
}

function trackSessionHeldProcess(child: SessionHolderChild): void {
    // A target's pids are not this Machine's; its Agents cannot reach this endpoint.
    if (child.target) return;
    trackSessionAgentTreeRoot(child, child);
}

function trackSessionAgentTreeRoot(root: SessionAgentTreeRoot, lifetime: Pick<NodeJS.EventEmitter, 'once'>): void {
    const scope = currentSessionHolderScope();
    let children = heldProcessesByScope.get(scope);
    if (!children) heldProcessesByScope.set(scope, children = new Set());
    children.add(root);
    const forget = () => { children.delete(root); };
    lifetime.once('exit', forget);
    lifetime.once('error', forget);
}

/**
 * A Session MCP relay an Agent in a target started (`holder serve --session-mcp`):
 * the holder admitted it from its Agent tree, answered its upgrade and carries
 * the connection as stream `relay` (stdout = relay → endpoint, stdin = endpoint → relay).
 */
export type SessionMcpRelayAcceptor = (relay: SessionHolderStreamProcess, options: Readonly<{ toolNameMaxLength?: number }>) => void;

/** Each Session's MCP endpoints that serve held relays, by hosted scope and registration identity. */
const sessionMcpRelayAcceptorsByScope = new WeakMap<object, Set<Readonly<{ acceptor: SessionMcpRelayAcceptor; registrationId?: string }>>>();

/** Registers the Session MCP endpoint of `scope` for relays its target holders carry; returns the unregistration. */
export function registerSessionMcpRelayAcceptor(scope: object, acceptor: SessionMcpRelayAcceptor, registrationId?: string): () => void {
    let acceptors = sessionMcpRelayAcceptorsByScope.get(scope);
    if (!acceptors) sessionMcpRelayAcceptorsByScope.set(scope, acceptors = new Set());
    const registration = { acceptor, registrationId };
    acceptors.add(registration);
    return () => { acceptors.delete(registration); };
}

export type SessionHolderHello = Readonly<{ protocol: number; holderPid: number; agentPid: number; replayFrom: number;
    /** The last state a client stored with the `meta` op (null until then). */
    meta?: unknown }>;

/**
 * `primary`: the Session's own Agent, the only one the daemon spares when a
 * runner crashes and the respawned runner adopts. Other held Agents (execution
 * runs, probes) keep today's lifetime: they end with their runner.
 */
export type SessionHolderRole = 'primary' | 'auxiliary';

/** Single-use hand-off from the daemon to a respawned runner: the held primary Agent to adopt. */
export const SESSION_HOLDER_ADOPT_ENV_KEY = 'HAPPIER_SESSION_HOLDER_ADOPT_V1';

export type SessionHolderAdoptToken = Readonly<{ socketPath: string; holderPid: number; agentPid: number;
    /** The Session turn the Agent was answering when its runner crashed. */
    turnId?: string }>;

/**
 * Set once an adopt attached: the Session turn the adopted Agent is still
 * answering. The Session's turn invariant takes it (single use) to map the
 * backend's provider-started turn onto it.
 */
const SESSION_HOLDER_ADOPTED_TURN_ENV_KEY = 'HAPPIER_SESSION_HOLDER_ADOPTED_TURN_V1';

/** The adopted Session turn for this Session environment, taken once. */
export function createSessionHolderAdoptedTurnReader(environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): () => string | null {
    return () => {
        const turnId = environment[SESSION_HOLDER_ADOPTED_TURN_ENV_KEY];
        if (!turnId) return null;
        delete environment[SESSION_HOLDER_ADOPTED_TURN_ENV_KEY];
        return turnId;
    };
}

/**
 * One held Agent of a runner, as the daemon records it in the Session marker. A
 * target-held Agent also names the relay its runner reaches the target through
 * (`relaySocketPath`): a restarted daemon serves it again for the surviving runner.
 */
export type SessionHeldAgentV1 = Omit<SessionHolderAdoptToken, 'turnId'> & Readonly<{ role: 'primary'; relaySocketPath?: string }>;

/**
 * A container/sandbox target that holds this Session's Agents (placement "target"):
 * the holder runs inside it, this Machine keeps the runner. Both operations go
 * through the target's Machine provider (`exec`, and the optional `stream` role).
 */
export type SessionHolderTarget = Readonly<{
    /** Stable identity of the target (never a path on this Machine). */
    id: string;
    /** The digest-checked holder executable inside the target. */
    holderPath: string;
    /** A private (0700) directory inside the target for holder sockets. */
    socketDirectory: string;
    /** One finite guest command; resolves with its exit status and output. */
    exec(command: string): Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
    /** A live non-PTY byte channel running `argv` in the target. */
    openChannel(argv: readonly string[]): Duplex;
    /**
     * The target launch preparation: this Machine's command/cwd mapped into the
     * target and the Agent's target environment (`launch.env` never crosses).
     * Awaits declared-file publication before launch; throws a typed refusal
     * for anything the launch step did not place there.
     */
    prepareLaunch?(launch: Readonly<{ command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv;
        requiredFiles?: readonly string[]; signal?: AbortSignal }>): Readonly<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<NodeJS.ProcessEnv> }>
        | Promise<Readonly<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<NodeJS.ProcessEnv> }>>;
}>;

export type AgentSessionHolderLaunch =
    | Readonly<{ kind: 'spawn'; executablePath: string; socketPath: string; role: SessionHolderRole; target?: SessionHolderTarget }>
    | Readonly<{ kind: 'adopt'; socketPath: string; role: 'primary'; turnId?: string; target?: SessionHolderTarget }>;

export type SessionHolderLaunch = Readonly<{
    executablePath: string;
    socketPath: string;
    command: string;
    args: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    requiredFiles?: readonly string[];
    signal?: AbortSignal;
    /** Windows: the args are a rendered command-line tail, appended unquoted. */
    windowsVerbatimArguments?: boolean;
    /** A terminal-mode Agent: the holder runs it in a pseudo-terminal of this size, not on pipes. */
    terminal?: Readonly<{ cols: number; rows: number }>;
    /** Placement: the holder and the Agent run in this target, not on this Machine. */
    target?: SessionHolderTarget;
}>;

/**
 * The one decision for an Agent launch's holder, shared by every Agent spawn
 * path (the Exec supervisor and the ACP transport).
 * - A `primary` launch in a runner the daemon handed an adopt token
 *   (`SESSION_HOLDER_ADOPT_ENV_KEY`, single use) attaches to that held Agent;
 *   in a placed Session it is the target's holder, attached through this
 *   runner's relay (the daemon probed it in the target before the hand-off; its
 *   pids are the target's, never checked here).
 * - A Session the daemon placed in a target (`SESSION_TARGET_PLACEMENT_ENV_KEY`)
 *   starts the holder there, through the daemon's relay (`sessionTargetRelay.ts`).
 * - Otherwise a new holder starts the Agent. The holder is a required part of
 *   every build: a missing executable is the typed launch refusal
 *   `session_holder_unavailable`, never a direct spawn without custody.
 */
export function resolveAgentSessionHolderLaunch(input: Readonly<{ role: SessionHolderRole }>): AgentSessionHolderLaunch {
    return resolveSessionProcessHolderLaunch(input)!;
}

/** Placement owns every Session process; only unplaced ordinary helpers remain direct. */
export function resolveSessionProcessHolderLaunch(input: Readonly<{ role?: SessionHolderRole }> = {}): AgentSessionHolderLaunch | null {
    // Placement "target": the daemon placed the holder in the target and relays its provider operations.
    const placement = readSessionTargetPlacement(sessionProcessEnvironment());
    if (input.role === 'primary') {
        const token = consumeSessionHolderAdoptToken();
        if (token && placement) {
            return Object.freeze({ kind: 'adopt', socketPath: token.socketPath, role: 'primary',
                ...(token.turnId ? { turnId: token.turnId } : {}), target: connectSessionTarget(placement) });
        }
        // The Agent may have ended between the daemon's check and this launch: start a new one.
        if (token && isPidPresent(token.holderPid) && isPidPresent(token.agentPid)) {
            return Object.freeze({ kind: 'adopt', socketPath: token.socketPath, role: 'primary',
                ...(token.turnId ? { turnId: token.turnId } : {}) });
        }
    }
    if (placement) {
        return Object.freeze({ kind: 'spawn', executablePath: placement.holderPath,
            socketPath: input.role === 'primary' && placement.primarySocketPath ? placement.primarySocketPath : createTargetHolderSocketPath(placement),
            role: input.role ?? 'auxiliary', target: connectSessionTarget(placement) });
    }
    if (!input.role) return null;
    return Object.freeze({ kind: 'spawn', executablePath: requireSessionHolderExecutablePath(),
        socketPath: createSessionHolderSocketPath(), role: input.role });
}

export type SessionProcessPtyTarget = Readonly<{
    rootPath: string;
    openHolder(): SessionHolderChild;
}>;

/**
 * Workspace PTYs attach beside the Session Agent, under the same admitted placement. The Session's
 * own terminal-mode Agent is not one of them: it is the target holder's held primary Agent.
 */
export function resolveSessionProcessPtyTarget(): SessionProcessPtyTarget | null {
    const placement = readSessionTargetPlacement(sessionProcessEnvironment());
    if (!placement) return null;
    if (!placement.primarySocketPath || !placement.launch?.workspace) {
        throw new PluginError({ code: 'agent_cli_target_unavailable', retryable: false,
            message: 'The placed Session has no target workspace holder for its terminal' });
    }
    const socketPath = placement.primarySocketPath;
    const workspace = placement.launch.workspace;
    const target = connectSessionTarget(placement);
    return { rootPath: workspace.hostRoot,
        openHolder: () => openSessionHolderWorkspaceClient(socketPath, target) };
}

/** Native process adapters share Exec's placement decision; the OS spawn is only for unplaced work. */
export function spawnSessionProcess(command: string, args: readonly string[], options: SpawnOptions & Readonly<{ requiredFiles?: readonly string[]; targetLaunchSignal?: AbortSignal }>,
    localSpawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn): ChildProcess {
    return spawnPlacedSessionProcess(command, args, options) ?? localSpawn(command, args, options);
}

/** The deadline/output owner can retain its local execFile path when placement is absent. */
export function spawnPlacedSessionProcess(command: string, args: readonly string[], options: SpawnOptions & Readonly<{ requiredFiles?: readonly string[]; targetLaunchSignal?: AbortSignal }>): ChildProcess | null {
    const holder = resolveSessionProcessHolderLaunch();
    if (!holder || holder.kind !== 'spawn') return null;
    const child = spawnSessionHolderChild({ ...holder, command, args,
        ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.requiredFiles ? { requiredFiles: options.requiredFiles } : {}),
        ...(options.targetLaunchSignal ?? options.signal ? { signal: options.targetLaunchSignal ?? options.signal } : {}),
        ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    if (options.stdio === 'inherit') {
        process.stdin.pipe(child.stdin);
        child.stdout.pipe(process.stdout, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
        child.once('close', () => process.stdin.unpipe(child.stdin));
    }
    return child;
}

/** Session Bash/workspace commands share the admitted holder source's cwd and environment policy. */
export function spawnPlacedSessionWorkspaceProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess | null {
    const target = resolveSessionProcessPtyTarget();
    if (!target) return null;
    const request = resolveHolderWorkspaceCommand(target.rootPath, {
        command: options.shell ? typeof options.shell === 'string' ? options.shell : 'sh' : command,
        args: options.shell ? ['-c', [command, ...args].join(' ')] : args,
        ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
    });
    const holder = target.openHolder();
    const child = holder.spawnStream(request);
    child.once('close', () => holder.detach());
    return child;
}

/**
 * The shipped holder executable (also the Session MCP relay Agents launch). Required in every
 * build: absence is the typed refusal `session_holder_unavailable`.
 */
export function requireSessionHolderExecutablePath(): string {
    const executablePath = resolveSessionHolderExecutablePath();
    if (!executablePath) {
        throw new PluginError({
            code: 'session_holder_unavailable',
            message: 'The Session holder is missing from this Happier build; rebuild the native artifacts or reinstall Happier',
            retryable: false,
        });
    }
    return executablePath;
}

/**
 * The holder executable as the Session's Agents can run it (the Session MCP relay
 * an Agent launches): in a placed Session the copy the daemon placed in the target.
 */
export function resolveAgentSessionHolderExecutablePath(): string {
    return readSessionTargetPlacement(sessionProcessEnvironment())?.holderPath ?? requireSessionHolderExecutablePath();
}

/**
 * The daemon records the Session's held primary Agent in its marker; on a runner
 * crash it spares that Agent and hands it to the respawned runner. A runner not
 * started by a daemon has nobody to tell (logged, not an error).
 */
function reportHeldPrimaryAgent(child: SessionHolderChild, sessionId: string | undefined): void {
    // A target-held Agent is recorded with the target's pids (the daemon reaches it through the target).
    const agentPid = child.target ? child.remoteAgentPid : child.pid;
    if (child.role !== 'primary' || !sessionId || child.holderPid === undefined || agentPid === undefined) return;
    const relaySocketPath = child.target ? readSessionTargetPlacement(sessionProcessEnvironment())?.relaySocketPath : undefined;
    const heldAgentsV1 = [{ role: 'primary' as const, socketPath: child.socketPath, holderPid: child.holderPid, agentPid, ...(relaySocketPath ? { relaySocketPath } : {}) }];
    void import('@/daemon/controlClient')
        .then(({ notifyDaemonSessionHolder }) => notifyDaemonSessionHolder({ sessionId, runnerPid: process.pid, heldAgentsV1 }))
        .catch(error => logger.debug('[SessionHolder] Held Agent not recorded with a daemon', { error: String(error) }));
}

/** Whether this Session's runner holds the daemon's hand-off of a held primary Agent (not consumed). */
export function hasSessionHolderAdoptToken(environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): boolean {
    return environment[SESSION_HOLDER_ADOPT_ENV_KEY] !== undefined;
}

function consumeSessionHolderAdoptToken(): SessionHolderAdoptToken | null {
    // The Session's own environment (a host may run several Sessions).
    const environment = sessionProcessEnvironment();
    const raw = environment[SESSION_HOLDER_ADOPT_ENV_KEY];
    if (raw === undefined) return null;
    // Single use: a later primary launch in this runner starts a new Agent.
    delete environment[SESSION_HOLDER_ADOPT_ENV_KEY];
    try {
        const token = JSON.parse(raw) as Partial<SessionHolderAdoptToken>;
        if (typeof token.socketPath === 'string' && typeof token.holderPid === 'number' && typeof token.agentPid === 'number') {
            return Object.freeze({ socketPath: token.socketPath, holderPid: token.holderPid, agentPid: token.agentPid,
                ...(typeof token.turnId === 'string' && token.turnId ? { turnId: token.turnId } : {}) });
        }
    } catch { /* malformed: refused below */ }
    throw new PluginError({ code: 'session_holder_adopt_token_invalid', message: 'The held Agent hand-off is malformed', retryable: false });
}

/**
 * A fresh per-launch holder address. POSIX: a 0700 `happier-h` directory under this user's
 * owner-only socket root (`resolveOwnerOnlySocketRoot`, shared with the local Session channel).
 * Windows: a local named pipe; the holder sets an owner-only DACL and rejects remote clients.
 */
export function createSessionHolderSocketPath(platform: NodeJS.Platform = process.platform): string {
    const id = randomBytes(12).toString('hex');
    if (platform === 'win32') return `\\\\.\\pipe\\happier-holder-${id}`;
    const directory = join(resolveOwnerOnlySocketRoot(join(HOLDER_DIRECTORY_NAME, `${id}.sock`)), HOLDER_DIRECTORY_NAME);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!isOwnerOnlyPath(directory)) {
        throw Object.assign(new Error('Session holder directory is not private to this user'), { code: 'session_holder_directory_unsafe' });
    }
    return join(directory, `${id}.sock`);
}

/** Short: on macOS the per-user temp root plus this leaf must stay under the socket path limit. */
const HOLDER_DIRECTORY_NAME = 'happier-h';

/** Whether `path` is an address `createSessionHolderSocketPath` hands out on this Machine (its private directory). */
export function isSessionHolderSocketPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
    if (platform === 'win32') return /^\\\\\.\\pipe\\happier-holder-[0-9a-f]{24}$/u.test(path);
    return /^[0-9a-f]{24}\.sock$/u.test(basename(path)) && dirname(path) === dirname(createSessionHolderSocketPath(platform));
}


function encodeFrame(kind: string, payload: Uint8Array): Buffer {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = kind.charCodeAt(0);
    header.writeUInt32BE(payload.byteLength, 1);
    return Buffer.concat([header, payload]);
}

function signalNumberToName(signal: number | null): NodeJS.Signals | null {
    if (signal === null) return null;
    for (const [name, value] of Object.entries(osConstants.signals)) {
        if (value === signal) return name as NodeJS.Signals;
    }
    return null;
}

function holderSignalName(signal: NodeJS.Signals | number | undefined): string {
    if (signal === undefined) return 'TERM';
    const name = typeof signal === 'number' ? signalNumberToName(signal) ?? 'TERM' : signal;
    return name.replace(/^SIG/, '');
}

/** Holder spawn failures keep Node's errno shape so spawn classification is unchanged. */
function spawnFailureError(ready: Readonly<{ code?: string; kind?: string; errno?: number | null; message?: string }>): NodeJS.ErrnoException {
    const errnoCode = ready.kind === 'NotFound' ? 'ENOENT' : ready.kind === 'PermissionDenied' ? 'EACCES' : ready.code ?? 'session_holder_failed';
    return Object.assign(new Error(ready.message ?? 'Agent could not be started by its holder'), {
        code: errnoCode,
        ...(typeof ready.errno === 'number' ? { errno: -ready.errno } : {}),
        syscall: 'spawn',
    });
}

/**
 * A process the holder started next to the Agent on the client's request (Git,
 * search, a language server, the custody helper): its pipes ride the holder
 * channel as numbered `O`/`E`/`X` frames and replay under the same ack rule.
 * Shaped like a child process for the workspace source's consumers.
 */
export class SessionHolderStreamProcess extends ChildProcess {
    override readonly stdin: Writable;
    override readonly stdout = new Readable({ read() {} });
    override readonly stderr = new Readable({ read() {} });
    declare readonly stdio: [Writable, Readable, Readable, undefined, undefined];
    streamId: number | undefined;
    override exitCode: number | null = null;
    override signalCode: NodeJS.Signals | null = null;
    private exited = false;

    constructor(private readonly holder: SessionHolderChild) {
        super();
        this.stdin = new Writable({
            write: (chunk: Buffer, _encoding, callback) => this.whenStarted(id => holder.sendStreamFrame('I', id, chunk, callback), callback),
            final: (callback) => this.whenStarted(id => holder.sendStreamFrame('C', id, new Uint8Array(), callback), callback),
        });
        Object.defineProperty(this, 'stdio', { value: [this.stdin, this.stdout, this.stderr, undefined, undefined], configurable: true });
    }

    private whenStarted(send: (id: number) => void, callback: (error?: Error | null) => void): void {
        if (this.streamId !== undefined) { send(this.streamId); return; }
        if (this.exited) { callback(Object.assign(new Error('Stream process is not running'), { code: 'EPIPE' })); return; }
        this.once('spawn', () => send(this.streamId!));
        this.once('error', (error: Error) => callback(error));
    }

    /** Terminal streams: new size in character cells. */
    resize(cols: number, rows: number): void {
        if (this.streamId === undefined || this.exited) return;
        void this.holder.request({ op: 'resize', stream: this.streamId, cols, rows });
    }

    /** Signals the stream's process group in the target. */
    override kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
        if (this.streamId === undefined || this.exited) return false;
        void this.holder.request({ op: 'kill', stream: this.streamId, signal: holderSignalName(signal) });
        return true;
    }

    /** TERM, then KILL after `graceMs`, settled by the stream's exit frame. */
    async terminateTree(graceMs: number = PROCESS_TERMINATION_GRACE_MS): Promise<void> {
        if (this.exited) return;
        if (this.streamId === undefined) {
            await new Promise<void>(resolve => {
                const ready = () => { this.off('spawn', ready); this.off('exit', ready); resolve(); };
                this.once('spawn', ready);
                this.once('exit', ready);
            });
        }
        if (this.exited) return;
        const exited = new Promise<void>(resolve => this.once('exit', () => resolve()));
        this.kill('SIGTERM');
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise<'grace'>(resolve => { timer = setTimeout(() => resolve('grace'), graceMs); });
        try {
            if (await Promise.race([exited, grace]) === 'grace') { this.kill('SIGKILL'); await exited; }
        } finally { clearTimeout(timer); }
    }

    /** @internal Holder frames for this stream. */
    deliver(kind: 'O' | 'E' | 'X', body: Buffer): void {
        if (kind === 'O') { this.stdout.push(body); return; }
        if (kind === 'E') { this.stderr.push(body); return; }
        const status = JSON.parse(body.toString('utf8')) as { code: number | null; signal: number | null };
        this.observeExit(status.code, signalNumberToName(status.signal));
    }

    /** @internal */
    observeExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.exited) return;
        this.exited = true;
        this.exitCode = code;
        this.signalCode = signal;
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit('exit', code, signal);
        // `close` once both pipes are consumed, as for a local child.
        let pending = 2;
        const done = () => { if (--pending === 0) this.emit('close', code, signal); };
        for (const stream of [this.stdout, this.stderr]) {
            if (stream.readableEnded) done();
            else { stream.once('end', done); if (stream.listenerCount('data') === 0) stream.resume(); }
        }
    }
}

/** Holder clients of this process with a live channel (a session host holds one per held Agent). */
const attachedHolderClients = new Set<SessionHolderChild>();

/**
 * Host handover: every attached holder client acknowledges what it delivered and closes its channel,
 * leaving each Agent running in its holder for the next host to adopt.
 */
/**
 * Host handover, first step: attached holder clients stop taking Agent output. What they did not
 * take stays unacknowledged in each holder and is replayed to the next host.
 */
export function pauseSessionHolderDelivery(): void {
    for (const client of attachedHolderClients) client.pauseDelivery();
}

export async function handOverSessionHolderClients(): Promise<void> {
    await Promise.all([...attachedHolderClients].map(client => client.handOver()));
}

export class SessionHolderChild extends ChildProcess {
    declare stdin: Writable;
    declare stdout: Readable;
    declare stderr: Readable;
    declare readonly stdio: [Writable, Readable, Readable, undefined, undefined];

    /** Holder address; a later runner attaches to the same Agent through it. */
    readonly socketPath: string;
    readonly role: SessionHolderRole;
    /** Set when the holder runs in a target: its pids are the target's, never this Machine's. */
    readonly target: SessionHolderTarget | undefined;
    /** Set when this client could not reach its holder (a later request opens a new client). */
    holderConnectionFailed = false;
    /** The Agent's pid in the target (a held target Agent has no local `pid`). */
    remoteAgentPid: number | undefined;
    holderPid: number | undefined;
    /** The state the previous runner stored (`meta` op); null for a fresh launch. */
    adoptedMeta: unknown = null;
    /** Settles once the holder said hello, so `adoptedMeta` is known. */
    readonly attached: Promise<void>;
    private resolveAttached!: () => void;
    private socket: Duplex | null = null;
    private reattaching = false;
    /** The current attachment received the holder's hello (it was live). */
    private attachmentLive = false;
    private buffered: Buffer = Buffer.alloc(0);
    private exitSeen = false;
    private closed = false;
    private finiteWorkspaceChannel = false;
    // Plain push streams: a flowing consumer receives each chunk synchronously
    // inside `push`, and anything not yet consumed is visible as readableLength,
    // which is what acknowledgement relies on.
    private readonly stdoutStream = new Readable({ read() {} });
    private readonly stderrStream = new Readable({ read() {} });
    private streamsEnded = false;
    private readonly pendingReplies = new Map<string, (reply: Record<string, unknown>) => void>();
    private readonly streams = new Map<number, SessionHolderStreamProcess>();
    /** Stream frames that arrived before their `spawn` reply named the stream. */
    private readonly unclaimedStreamFrames = new Map<number, Array<['O' | 'E' | 'X', Buffer]>>();
    private nextReplyId = 1;
    /** The Session this client serves (its Session MCP endpoint takes the relays the holder carries). */
    private readonly holderScope = currentSessionHolderScope();

    constructor(socketPath: string, role: SessionHolderRole = 'auxiliary', target?: SessionHolderTarget) {
        super();
        this.socketPath = socketPath;
        this.role = role;
        this.target = target;
        this.attached = new Promise(resolve => { this.resolveAttached = resolve; });
        // A holder that never said hello leaves nothing to wait for.
        this.once('error', () => this.resolveAttached());
        const stdin = new Writable({
            write: (chunk: Buffer, _encoding, callback) => this.sendFrame('i', chunk, callback),
            final: (callback) => this.sendFrame('c', new Uint8Array(), callback),
        });
        Object.defineProperty(this, 'stdin', { value: stdin, writable: true, configurable: true });
        Object.defineProperty(this, 'stdout', { value: this.stdoutStream, writable: true, configurable: true });
        Object.defineProperty(this, 'stderr', { value: this.stderrStream, writable: true, configurable: true });
        Object.defineProperty(this, 'stdio', { value: [stdin, this.stdoutStream, this.stderrStream, undefined, undefined], configurable: true });
    }

    /** Asks the holder to signal the Agent's process group (Windows: the Agent root). */
    override kill(signal?: NodeJS.Signals | number): boolean {
        if (this.exitSeen || !this.socket) return false;
        void this.request({ op: 'signal', signal: holderSignalName(signal) });
        return true;
    }

    /**
     * Stop for a target-held Agent (the supervisor's tree terminator cannot reach
     * target pids): TERM to the Agent's process group through the holder, KILL
     * after the supervisor's grace, settled by the holder's exit frame.
     */
    async terminateGroup(options: Readonly<{ graceMs: number; firstSignal?: 'SIGHUP' | 'SIGINT' | 'SIGTERM' | 'SIGKILL' }>): Promise<void> {
        if (this.exitSeen) return;
        const exited = new Promise<void>(resolve => this.once('exit', () => resolve()));
        await this.request({ op: 'signal', signal: holderSignalName(options.firstSignal ?? 'SIGTERM') });
        let timer: NodeJS.Timeout | undefined;
        const graceElapsed = new Promise<'grace'>(resolve => { timer = setTimeout(() => resolve('grace'), options.graceMs); });
        try {
            if (await Promise.race([exited, graceElapsed]) === 'grace') {
                await this.request({ op: 'signal', signal: 'KILL' });
                await exited;
            }
        } finally { clearTimeout(timer); }
    }

    /**
     * Starts a process next to the Agent (`cwd` relative to the Session root the
     * holder runs in). Returns at once; `spawn` or `error` (`ENOENT`, `EACCES`,
     * `workspace_root_unsafe`) follows, so listeners attach first.
     */
    spawnStream(request: Readonly<{ argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }>
        | Readonly<{ op: 'pty'; argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>>; cols: number; rows: number }>
        | Readonly<{ op: 'watch'; path: string; recursive: boolean }>): SessionHolderStreamProcess {
        const process = new SessionHolderStreamProcess(this);
        const body = 'op' in request ? { ...request, ...('argv' in request ? { argv: [...request.argv] } : {}) }
            : { op: 'spawn', argv: [...request.argv], ...(request.cwd ? { cwd: request.cwd } : {}), ...(request.env ? { env: request.env } : {}) };
        const label = 'argv' in request ? request.argv[0] : 'watch';
        const refuseStart = (error: unknown) => {
            process.emit('error', error instanceof Error ? error : new Error(String(error)));
            process.observeExit(null, null);
        };
        void this.request(body)
            .then((reply) => {
                const value = reply.value as { stream?: unknown } | undefined;
                if (reply.ok !== true || typeof value?.stream !== 'number') {
                    const code = typeof reply.code === 'string' ? reply.code : typeof reply.error === 'string' ? reply.error : 'spawn_failed';
                    refuseStart(this.target && code === 'holder_disconnected'
                        ? new PluginError({ code: 'agent_cli_target_unavailable', retryable: false,
                            message: 'The Session target workspace holder is unavailable' })
                        : Object.assign(new Error(`Session holder could not start ${label}`), { code, syscall: 'spawn' }));
                    return;
                }
                process.streamId = value.stream;
                this.streams.set(value.stream, process);
                process.once('exit', () => this.streams.delete(value.stream as number));
                process.emit('spawn');
                for (const [kind, body] of this.unclaimedStreamFrames.get(value.stream) ?? []) process.deliver(kind, body);
                this.unclaimedStreamFrames.delete(value.stream);
            }, refuseStart);
        return process;
    }

    /** @internal Stream stdin frames (`I` bytes, `C` end). */
    sendStreamFrame(kind: 'I' | 'C', stream: number, bytes: Uint8Array, callback: (error?: Error | null) => void): void {
        const payload = Buffer.alloc(4 + bytes.byteLength);
        payload.writeUInt32BE(stream, 0);
        payload.set(bytes, 4);
        this.sendFrame(kind, payload, callback);
    }

    /** Opens a channel to this child's holder: a local socket, or the target's provider channel. */
    openChannel(): Duplex {
        return this.target
            ? this.target.openChannel([this.target.holderPath, 'attach', '--socket', this.socketPath])
            : connect(this.socketPath);
    }

    /**
     * A dropped target channel leaves the Agent's state unknown: attach again. The
     * holder replays every frame no attachment acknowledged; frames this child
     * already delivered are skipped. Input written meanwhile waits for the new channel.
     */
    reattach(): Promise<void> {
        if (this.socket || this.exitSeen || this.closed) return Promise.resolve();
        this.reattaching = true;
        return new Promise((resolve, reject) => connectHolder(this, () => resolve(), (error) => {
            this.reattaching = false;
            // Input queued for this attach fails like any write to an unattached holder; the next write tries again.
            for (const [, , callback] of this.pendingFrames.splice(0)) callback(Object.assign(new Error('Session holder is not attached'), { code: 'EPIPE' }));
            reject(error);
        }));
    }

    /**
     * Host handover: acknowledge the output this client delivered, then close its channel once the
     * acknowledgement is written. The Agent keeps running in its holder; a newer host adopts it and
     * receives only what was never delivered here.
     */
    handOver(): Promise<void> {
        const socket = this.socket;
        if (!socket || socket.destroyed) return Promise.resolve();
        this.acknowledgeDelivered();
        this.closed = true;
        this.socket = null;
        return new Promise((resolve) => {
            socket.once('close', () => resolve());
            socket.end(() => socket.destroy());
        });
    }

    /** Stops delivering Agent output; undelivered frames stay unacknowledged in the holder. */
    pauseDelivery(): void {
        this.deliveryPaused = true;
    }

    /** Leaves the Agent running and the holder holding it, for a later attach. */
    detach(): void {
        this.closed = true;
        this.socket?.destroy();
        this.socket = null;
    }

    /** A terminal-mode Agent (`terminal` launch): its terminal's new size in character cells. */
    async resizeTerminal(cols: number, rows: number): Promise<boolean> {
        if (this.exitSeen || this.closed) return false;
        const reply = await this.request({ op: 'resize', cols: Math.trunc(cols), rows: Math.trunc(rows) });
        return reply.ok === true;
    }

    /**
     * Stores the adopt state in the holder for the next runner. Fire-and-forget on
     * the same socket as the Agent's input, so it is written before input sent after it.
     */
    publishAdoptState(value: unknown): void {
        if (this.exitSeen || this.closed) return;
        void this.request({ op: 'meta', value });
    }

    request(body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
        const id = String(this.nextReplyId++);
        return new Promise((resolve) => {
            this.pendingReplies.set(id, resolve);
            this.sendFrame('q', Buffer.from(JSON.stringify({ ...body, id }), 'utf8'), (error) => {
                if (!error) return;
                this.pendingReplies.delete(id);
                resolve({ id, ok: false, error: 'holder_disconnected' });
            });
        });
    }

    attachSocket(socket: Duplex, onHello: (hello: SessionHolderHello) => void, pauseAfterHello = false): void {
        this.socket = socket;
        attachedHolderClients.add(this);
        this.attachedOnce = true;
        this.attachmentLive = false;
        for (const [kind, payload, callback] of this.pendingFrames.splice(0)) this.sendFrame(kind, payload, callback);
        this.onHello = onHello;
        this.pauseAfterHello = pauseAfterHello;
        socket.on('data', (data: Buffer) => {
            this.buffered = this.buffered.byteLength ? Buffer.concat([this.buffered, data]) : data;
            this.deliverFrames();
        });
        for (const stream of [this.stdoutStream, this.stderrStream]) {
            // Buffered output reaches its consumer when it starts reading; the
            // flush runs after `resume`, so acknowledge once it has run.
            stream.on('resume', () => setImmediate(() => this.acknowledgeDelivered()));
        }
        socket.on('error', () => { /* `close` below owns the outcome. */ });
        socket.on('close', () => {
            if (this.socket === socket) this.socket = null;
            if (!this.socket) attachedHolderClients.delete(this);
            for (const [id, resolve] of this.pendingReplies) resolve({ id, ok: false, error: 'holder_disconnected' });
            this.pendingReplies.clear();
            if (this.closed || this.exitSeen) return;
            if (this.finiteWorkspaceChannel) {
                this.closed = true;
                this.holderConnectionFailed = true;
                for (const stream of this.streams.values()) stream.observeExit(null, null);
                this.emit('holderDisconnected');
                return;
            }
            // A dropped channel is not an exit: only the holder's exit frame says
            // the Agent ended (a newer runner may have attached, or an exec
            // channel broke). The one exception is a local fact: the holder and
            // the Agent are both gone, so no exit frame can ever arrive. A target's
            // pids are not this Machine's, so a target channel only reattaches.
            if (this.target) {
                this.emit('holderDisconnected');
                // One reattach per live channel that dropped; a channel that never
                // reached the holder is reported, not retried.
                if (this.attachmentLive) {
                    this.reattach().catch(error => logger.debug('[SessionHolder] Target reattach failed; Agent state unknown', { error: String(error) }));
                }
                return;
            }
            if (this.holderPid !== undefined && !isPidPresent(this.holderPid) && (this.pid === undefined || !isPidPresent(this.pid))) {
                this.closed = true;
                this.observeExit({ code: null, signal: null });
                this.observeStreamsClosed();
                return;
            }
            this.emit('holderDisconnected');
        });
    }

    /** A finite workspace-only process has no socket to reconnect to. */
    attachWorkspaceChannel(channel: Duplex, onHello: (hello: SessionHolderHello) => void): void {
        this.finiteWorkspaceChannel = true;
        this.attachSocket(channel, onHello);
    }

    /** The Agent never started: queued input fails instead of waiting forever. */
    abandonPendingInput(error: Error): void {
        this.closed = true;
        this.exitSeen = true;
        for (const [, , callback] of this.pendingFrames.splice(0)) callback(error);
        this.stdoutStream.push(null);
        this.stderrStream.push(null);
        // Match a failed OS spawn: error first, then closed pipes and close.
        process.nextTick(() => this.emit('close', null, null));
    }

    /** An adopting caller wires its listeners first, then starts delivery. */
    resumeDelivery(): void {
        // Called before the hello when adopting by address: the hello must not pause again.
        this.deliveryResumed = true;
        this.deliveryPaused = false;
        this.deliverFrames();
    }

    private deliveryResumed = false;

    private onHello: ((hello: SessionHolderHello) => void) | null = null;
    private attachedOnce = false;
    private readonly pendingFrames: Array<[string, Uint8Array, (error?: Error | null) => void]> = [];
    private pauseAfterHello = false;
    private deliveryPaused = false;
    private deliveredSeq = 0;
    private acknowledgedSeq = 0;

    private deliverFrames(): void {
        while (!this.deliveryPaused && this.buffered.byteLength >= FRAME_HEADER_BYTES) {
            const length = this.buffered.readUInt32BE(1);
            if (this.buffered.byteLength < FRAME_HEADER_BYTES + length) break;
            const kind = String.fromCharCode(this.buffered[0]!);
            const payload = this.buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
            this.buffered = this.buffered.subarray(FRAME_HEADER_BYTES + length);
            if (kind === 'H') {
                const hello = JSON.parse(payload.toString('utf8')) as SessionHolderHello;
                this.attachmentLive = true;
                this.reattaching = false;
                this.adoptedMeta = hello.meta ?? null;
                this.resolveAttached();
                if (this.pauseAfterHello && !this.deliveryResumed) this.deliveryPaused = true;
                this.onHello?.(hello);
                continue;
            }
            if (kind === 'r') {
                const reply = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
                const id = typeof reply.id === 'string' ? reply.id : '';
                this.pendingReplies.get(id)?.(reply);
                this.pendingReplies.delete(id);
                continue;
            }
            const seq = Number(payload.readBigUInt64BE(0));
            const body = payload.subarray(8);
            // A replayed frame this attachment already delivered is skipped.
            if (seq <= this.deliveredSeq) continue;
            this.deliveredSeq = seq;
            if (kind === 'o') this.stdoutStream.push(Buffer.from(body));
            else if (kind === 'e') this.stderrStream.push(Buffer.from(body));
            else if (kind === 'x') this.observeExit(JSON.parse(body.toString('utf8')) as { code: number | null; signal: number | null });
            else if (kind === 'z') this.observeStreamsClosed();
            else if (kind === 'M') this.acceptSessionMcpRelay(body.readUInt32BE(0), body.subarray(4));
            else if (kind === 'O' || kind === 'E' || kind === 'X') {
                const stream = body.readUInt32BE(0);
                const data = Buffer.from(body.subarray(4));
                const owner = this.streams.get(stream);
                if (owner) owner.deliver(kind, data);
                else {
                    // Output (or the exit) may beat the `spawn` reply on the channel.
                    const pending = this.unclaimedStreamFrames.get(stream) ?? [];
                    pending.push([kind, data]);
                    this.unclaimedStreamFrames.set(stream, pending);
                }
            }
        }
        this.acknowledgeDelivered();
    }

    /** A relay the holder admitted (`M`): its stream goes to the Session's MCP endpoint, or is closed when none serves. */
    private acceptSessionMcpRelay(stream: number, body: Buffer): void {
        const relay = new SessionHolderStreamProcess(this);
        relay.streamId = stream;
        this.streams.set(stream, relay);
        relay.once('exit', () => this.streams.delete(stream));
        let options: unknown;
        try { options = JSON.parse(body.toString('utf8')); } catch { /* invalid opening is unresolved */ }
        const opening = typeof options === 'object' && options !== null && !Array.isArray(options) ? options : undefined;
        const registrationId = opening && 'registrationId' in opening ? opening.registrationId : undefined;
        const candidates = opening ? [...(sessionMcpRelayAcceptorsByScope.get(this.holderScope) ?? [])]
            .filter(registration => !('registrationId' in opening) || typeof registrationId === 'string'
                && registration.registrationId === registrationId) : [];
        const toolNameMaxLength = opening && 'toolNameMaxLength' in opening && typeof opening.toolNameMaxLength === 'number'
            ? opening.toolNameMaxLength : undefined;
        if (candidates.length === 1) candidates[0].acceptor(relay, toolNameMaxLength === undefined ? {} : { toolNameMaxLength });
        else {
            logger.debug('[SessionHolder] Session MCP relay closed: registration unresolved');
            relay.stdin.end();
        }
    }

    /**
     * Cumulative acknowledgement, sent only once delivered output has left the
     * stream buffers for its consumers (flowing streams hand `data` over
     * synchronously; buffered ones wait for their reader).
     */
    private acknowledgeDelivered(): void {
        const socket = this.socket;
        if (!socket || socket.destroyed || this.deliveredSeq <= this.acknowledgedSeq) return;
        if (this.stdoutStream.readableLength > 0 || this.stderrStream.readableLength > 0) return;
        this.acknowledgedSeq = this.deliveredSeq;
        const ack = Buffer.alloc(8);
        ack.writeBigUInt64BE(BigInt(this.acknowledgedSeq));
        socket.write(encodeFrame('a', ack));
    }

    private sendFrame(kind: string, payload: Uint8Array, callback: (error?: Error | null) => void): void {
        const socket = this.socket;
        if (!socket && (!this.attachedOnce || this.reattaching) && !this.closed) {
            // Input written before the holder reported the Agent (the launch
            // preamble) is sent, in order, as soon as the client attaches.
            this.pendingFrames.push([kind, payload, callback]);
            return;
        }
        if (!socket && this.target && !this.closed && !this.exitSeen) {
            // A target channel whose reattach found no relay (the daemon was restarting): the runner's next use
            // attaches again through the relay the restarted daemon serves at the same address.
            this.pendingFrames.push([kind, payload, callback]);
            this.reattach().catch(error => logger.debug('[SessionHolder] Target reattach failed; Agent state unknown', { error: String(error) }));
            return;
        }
        if (!socket || socket.destroyed) {
            callback(Object.assign(new Error('Session holder is not attached'), { code: 'EPIPE' }));
            return;
        }
        socket.write(encodeFrame(kind, payload), (error) => callback(error ?? null));
    }

    private observeExit(status: Readonly<{ code: number | null; signal: number | null }>): void {
        if (this.exitSeen) return;
        this.exitSeen = true;
        const signal = signalNumberToName(status.signal);
        Object.defineProperty(this, 'exitCode', { value: status.code, writable: true, configurable: true });
        Object.defineProperty(this, 'signalCode', { value: signal, writable: true, configurable: true });
        this.emit('exit', status.code, signal);
    }

    private observeStreamsClosed(): void {
        if (this.streamsEnded) return;
        this.streamsEnded = true;
        let pending = 2;
        const done = () => {
            if (--pending > 0) return;
            this.closed = true;
            this.socket?.end();
            this.emit('close', this.exitCode, this.signalCode);
        };
        this.stdoutStream.once('end', done);
        this.stderrStream.once('end', done);
        this.stdoutStream.push(null);
        this.stderrStream.push(null);
        // Ending a stream nobody reads never emits `end`; drain unread ones.
        if (this.stdoutStream.listenerCount('data') === 0) this.stdoutStream.resume();
        if (this.stderrStream.listenerCount('data') === 0) this.stderrStream.resume();
    }
}

function connectHolder(child: SessionHolderChild, onHello: (hello: SessionHolderHello) => void, onError: (error: Error) => void,
    pauseAfterHello = false): void {
    const channel = child.openChannel();
    if (child.target) {
        // A provider channel has no connect event: the holder's hello proves the attach.
        let helloSeen = false;
        const failed = (error?: Error) => { if (!helloSeen) onError(error ?? Object.assign(new Error('Session holder channel ended before attach'), { code: 'session_holder_failed' })); };
        channel.once('error', failed);
        channel.once('close', () => failed());
        child.attachSocket(channel, (hello) => { helloSeen = true; onHello(hello); }, pauseAfterHello);
        return;
    }
    channel.once('connect', () => {
        channel.off('error', onError);
        child.attachSocket(channel, onHello, pauseAfterHello);
    });
    channel.once('error', onError);
}

/** `serve --pty <cols>x<rows>` for a terminal-mode Agent. */
function holderTerminalArgs(launch: Pick<SessionHolderLaunch, 'terminal'>): string[] {
    if (!launch.terminal) return [];
    const size = (value: number) => Math.max(1, Math.min(0xffff, Math.trunc(value)));
    return ['--pty', `${size(launch.terminal.cols)}x${size(launch.terminal.rows)}`];
}

/**
 * Starts the holder, which starts the Agent. Emits `spawn` once the holder
 * reported the Agent's pid and the client is attached, or `error` with the
 * Agent's spawn failure.
 */
export function spawnSessionHolderChild(
    launch: SessionHolderLaunch & Readonly<{ role?: SessionHolderRole }>,
    spawnOptions: Omit<SpawnOptionsWithoutStdio, 'cwd' | 'env' | 'stdio' | 'detached'> = {},
): SessionHolderChild {
    if (launch.target) return spawnTargetSessionHolderChild(launch, launch.target);
    const child = new SessionHolderChild(launch.socketPath, launch.role);
    const holderArgs = ['serve', '--socket', launch.socketPath,
        ...(launch.windowsVerbatimArguments ? ['--windows-verbatim'] : []), ...holderTerminalArgs(launch), '--', launch.command, ...launch.args];
    // Windows: the holder outlives its runner as on Linux and macOS. The custody helper starts it
    // outside the runner's owner Job (whose cleanup terminates that Job), in a kill-on-close Job of
    // its own, and exits; the holder's readiness line still arrives on this stdout.
    const heldLaunchHelper = process.platform === 'win32' ? resolveProcessCustodySupportExecutable('win32') : null;
    if (process.platform === 'win32' && !heldLaunchHelper) {
        throw new PluginError({ code: 'session_holder_unavailable', retryable: false,
            message: 'The process-custody helper is missing from this Happier build; the Session holder cannot outlive its runner' });
    }
    const holder = heldLaunchHelper
        ? spawn(heldLaunchHelper, ['held-launch', '--', launch.executablePath, ...holderArgs], {
            ...spawnOptions,
            ...(launch.cwd ? { cwd: launch.cwd } : {}),
            ...(launch.env ? { env: launch.env } : {}),
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        })
        : spawn(launch.executablePath, holderArgs, {
        ...spawnOptions,
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
        ...(launch.env ? { env: launch.env } : {}),
        // The holder outlives this runner by design.
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
    });
    child.holderPid = holder.pid;
    trackSessionHeldProcess(child);
    const sessionId = readHostedSessionScope()?.sessionId;
    let line = '';
    let settled = false;
    const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.abandonPendingInput(error);
        child.emit('error', error);
    };
    holder.once('error', fail);
    let launcherError = '';
    holder.stderr?.setEncoding('utf8');
    holder.stderr?.on('data', (chunk: string) => { if (launcherError.length < 4096) launcherError += chunk; });
    const ended = () => fail(Object.assign(new Error(`Session holder ended before the Agent started${launcherError ? `: ${launcherError.trim()}` : ''}`), { code: 'session_holder_failed' }));
    // The Windows launcher exits as soon as the holder runs; only its failure ends the start. The
    // holder's own end shows as its stdout closing without a readiness line.
    holder.once('exit', (code: number | null) => { if (!heldLaunchHelper || code !== 0) ended(); });
    // The holder closes its stdout after the readiness line; only an end without one is a failure.
    let readinessReceived = false;
    holder.stdout.once('end', () => { if (!readinessReceived) ended(); });
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (chunk: string) => {
        if (settled) return;
        line += chunk;
        const end = line.indexOf('\n');
        if (end < 0) return;
        readinessReceived = true;
        const ready = JSON.parse(line.slice(0, end)) as { ready: boolean; agentPid?: number; holderPid?: number; code?: string; kind?: string; errno?: number | null; message?: string };
        if (!ready.ready || typeof ready.agentPid !== 'number') {
            fail(spawnFailureError(ready));
            return;
        }
        Object.defineProperty(child, 'pid', { value: ready.agentPid, writable: true, configurable: true });
        // The holder's own pid (the Windows launcher's pid is not the holder's).
        if (typeof ready.holderPid === 'number') child.holderPid = ready.holderPid;
        connectHolder(child, () => {
            if (settled) return;
            settled = true;
            holder.removeAllListeners('exit');
            holder.stdout.removeAllListeners('end');
            holder.stdout.destroy();
            holder.stderr?.destroy();
            // The Windows launcher could not take the holder out of an enclosing Job: the Agent
            // runs and is held, but ends with that Job (not observable anywhere else).
            if (launcherError.includes('held-launch:')) logger.warn('[SessionHolder] Held Agent stays in an enclosing Job', { detail: launcherError.trim() });
            holder.unref();
            child.emit('spawn');
            reportHeldPrimaryAgent(child, sessionId);
        }, fail);
    });
    return child;
}

/**
 * Starts the holder inside a target through one finite provider exec. The holder
 * detaches from the exec session (`nohup`, background), so the exec ends while it
 * keeps the Agent; its one readiness line comes back through a private FIFO. The
 * client then attaches over the target's provider channel.
 *
 * Environment: the target's own plus the target launch preparation's Agent
 * environment (`target.prepareLaunch`). `launch.env` never crosses: it is this
 * Machine's launch environment (its paths and credentials are not the target's).
 */
function spawnTargetSessionHolderChild(launch: SessionHolderLaunch & Readonly<{ role?: SessionHolderRole }>, target: SessionHolderTarget): SessionHolderChild {
    const child = new SessionHolderChild(launch.socketPath, launch.role, target);
    const sessionId = readHostedSessionScope()?.sessionId;
    let settled = false;
    const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.abandonPendingInput(error);
        child.emit('error', error);
    };
    const q = safeBashSingleQuote;
    const prepare = async () => {
        const prepared = target.prepareLaunch
            ? await target.prepareLaunch({ command: launch.command, args: launch.args, ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
                ...(launch.env ? { env: launch.env } : {}), ...(launch.requiredFiles ? { requiredFiles: launch.requiredFiles } : {}),
                ...(launch.signal ? { signal: launch.signal } : {}) })
            : { command: launch.command, args: launch.args, ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}), env: {} };
        const argv = [prepared.command, ...prepared.args];
        const ready = `${launch.socketPath}.ready`;
        const command = ['umask 077', `rm -f ${q(ready)}`, `mkfifo ${q(ready)}`,
            ...(prepared.cwd ? [`cd ${q(prepared.cwd)}`] : []),
            // Every held Agent's Session MCP relays reach this Machine through its own holder (`--session-mcp`).
            `nohup ${[target.holderPath, 'serve', '--socket', launch.socketPath, '--session-mcp', ...holderTerminalArgs(launch), '--', ...argv].map(q).join(' ')} >${q(ready)} 2>/dev/null </dev/null &`,
            `head -n 1 ${q(ready)}`, `rm -f ${q(ready)}`].join('\n');
        launch.signal?.throwIfAborted();
        return execWithManagedChannelEnvironment({ path: `${launch.socketPath}.environment`, environment: prepared.env,
            command, ...(launch.signal ? { signal: launch.signal } : {}),
            exec: command => target.exec(command), openChannel: argv => target.openChannel(argv) });
    };
    void prepare().then((result) => {
        const line = result.stdout.split('\n')[0] ?? '';
        let readiness: { ready?: boolean; agentPid?: number; holderPid?: number; code?: string; kind?: string; errno?: number | null; message?: string };
        try { readiness = JSON.parse(line); } catch {
            fail(Object.assign(new Error('Session holder did not start in the target'), { code: 'session_holder_failed' }));
            return;
        }
        if (!readiness.ready || typeof readiness.agentPid !== 'number') {
            fail(spawnFailureError(readiness));
            return;
        }
        child.remoteAgentPid = readiness.agentPid;
        child.holderPid = readiness.holderPid;
        connectHolder(child, () => {
            if (settled) return;
            settled = true;
            child.emit('spawn');
            reportHeldPrimaryAgent(child, sessionId);
        }, fail);
    }, (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    return child;
}

/**
 * Attaches to an existing holder (a replacement runner adopting a running
 * Agent). The holder replays every output frame no previous client acknowledged.
 * Delivery waits for `resumeDelivery()`, so the adopter's listeners see the
 * replay and any exit that happened while no runner was attached.
 */
export function attachSessionHolderChild(socketPath: string, role: SessionHolderRole = 'auxiliary'): Promise<SessionHolderChild> {
    const child = new SessionHolderChild(socketPath, role);
    return new Promise((resolve, reject) => {
        connectHolder(child, (hello) => {
            Object.defineProperty(child, 'pid', { value: hello.agentPid, writable: true, configurable: true });
            child.holderPid = hello.holderPid;
            child.adoptedMeta = hello.meta ?? null;
            trackSessionHeldProcess(child);
            resolve(child);
        }, reject, true);
    });
}

/**
 * A workspace-operations client of a held Session (file ops, Git, search, watches,
 * terminals): any number may attach at `<socket>.ops` beside the one Agent-control
 * client, so workspace work neither depends on nor routes through the runner. The
 * holder refuses the Agent's stdio, process and state ops on this socket.
 */
/**
 * A workspace client usable at once: requests queue until it reaches the holder;
 * if it cannot (no holder yet, holder gone) they fail and `holderConnectionFailed` is set.
 */
export function openSessionHolderWorkspaceClient(socketPath: string, target?: SessionHolderTarget): SessionHolderChild {
    const client = new SessionHolderChild(`${socketPath}.ops`, 'auxiliary', target);
    connectHolder(client, (hello) => { client.holderPid = hello.holderPid; }, (error) => {
        client.holderConnectionFailed = true;
        client.abandonPendingInput(target ? new PluginError({ code: 'agent_cli_target_unavailable', retryable: false,
            message: 'The Session target workspace holder is unavailable' }, { cause: error }) : error);
    });
    return client;
}

export function attachSessionHolderWorkspaceClient(socketPath: string, target?: SessionHolderTarget): Promise<SessionHolderChild> {
    const client = new SessionHolderChild(`${socketPath}.ops`, 'auxiliary', target);
    return new Promise((resolve, reject) => {
        connectHolder(client, (hello) => {
            client.holderPid = hello.holderPid;
            resolve(client);
        }, reject);
    });
}

/** Existing holder frames over one admitted provider pipe, before an Agent exists. */
export function attachSessionHolderWorkspaceChannel(channel: Duplex): Promise<SessionHolderChild> {
    const client = new SessionHolderChild('workspace-stdio');
    return new Promise((resolve, reject) => {
        let attached = false;
        const failed = () => { if (!attached) reject(new PluginError({ code: 'agent_cli_target_unavailable',
            message: 'The Session target workspace channel is unavailable', retryable: false })); };
        channel.once('error', failed);
        channel.once('close', failed);
        client.attachWorkspaceChannel(channel, hello => {
            attached = true;
            client.holderPid = hello.holderPid;
            resolve(client);
        });
    });
}

/**
 * Daemon-side check before sparing a crashed runner's Agent: the holder at this
 * address is the recorded one, its Agent is alive, and its client stored adopt
 * state (so a respawned runner can take the Agent over). Attaching as a probe
 * acknowledges nothing, so the replay stays for the adopter.
 */
export function probeAdoptableSessionHolder(held: SessionHeldAgentV1): Promise<boolean> {
    if (!isPidPresent(held.holderPid) || !isPidPresent(held.agentPid)) return Promise.resolve(false);
    return readAdoptableHolderHello(connect(held.socketPath), held);
}

/**
 * The adoptable check over an attach channel (a local socket, or a target's
 * provider channel running `holder attach`): the hello names the recorded
 * holder and Agent and carries the stored primary adopt state. Reads the hello
 * only, so the replay stays for the adopter; the channel is closed after.
 */
export function readAdoptableHolderHello(channel: Duplex, held: SessionHeldAgentV1): Promise<boolean> {
    return new Promise((resolve) => {
        let buffered = Buffer.alloc(0);
        let settled = false;
        const finish = (adoptable: boolean) => { if (settled) return; settled = true; channel.destroy(); resolve(adoptable); };
        channel.once('error', () => finish(false));
        channel.once('close', () => finish(false));
        channel.on('data', (data: Buffer) => {
            buffered = Buffer.concat([buffered, data]);
            if (buffered.byteLength < FRAME_HEADER_BYTES) return;
            const length = buffered.readUInt32BE(1);
            if (buffered.byteLength < FRAME_HEADER_BYTES + length) return;
            if (String.fromCharCode(buffered[0]!) !== 'H') return finish(false);
            try {
                const hello = JSON.parse(buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length).toString('utf8')) as SessionHolderHello;
                const meta = hello.meta as { role?: unknown } | null | undefined;
                finish(hello.holderPid === held.holderPid && hello.agentPid === held.agentPid && meta?.role === 'primary');
            } catch {
                finish(false);
            }
        });
    });
}

/**
 * The launch-owner form of adopt, shaped like `spawnSessionHolderChild`: the
 * child is returned at once and emits `spawn` once attached (pid and stored
 * state known) or `error` when the holder is gone. Input written earlier is sent
 * first after attach; the replay is delivered after the caller's listeners exist.
 */
export function adoptSessionHolderChild(launch: Readonly<{ socketPath: string; role: SessionHolderRole; turnId?: string; target?: SessionHolderTarget }>): SessionHolderChild {
    const child = new SessionHolderChild(launch.socketPath, launch.role, launch.target);
    const environment = sessionProcessEnvironment();
    const sessionId = readHostedSessionScope()?.sessionId;
    connectHolder(child, (hello) => {
        // A target's pids are not this Machine's: the held target Agent has no local pid.
        if (launch.target) child.remoteAgentPid = hello.agentPid;
        else Object.defineProperty(child, 'pid', { value: hello.agentPid, writable: true, configurable: true });
        child.holderPid = hello.holderPid;
        child.adoptedMeta = hello.meta ?? null;
        trackSessionHeldProcess(child);
        // Only an Agent that is really adopted carries the previous runner's turn.
        if (launch.turnId) environment[SESSION_HOLDER_ADOPTED_TURN_ENV_KEY] = launch.turnId;
        child.emit('spawn');
        // The respawned runner now holds the Agent: the daemon records it again.
        reportHeldPrimaryAgent(child, sessionId);
    }, (error) => {
        child.abandonPendingInput(error);
        child.emit('error', Object.assign(error, { syscall: 'spawn' }));
    }, true);
    return child;
}
