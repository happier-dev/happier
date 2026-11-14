import { ChildProcess, spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable, Writable, type Duplex } from 'node:stream';
import { constants as osConstants } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { readHostedSessionScope, sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { logger } from '@/ui/logger';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { connectSessionTarget, createTargetHolderSocketPath, readSessionTargetPlacement } from './sessionTargetRelay';

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

/** Each Session's MCP endpoints that serve held relays, by hosted scope; the first registered (the Session's own) serves. */
const sessionMcpRelayAcceptorsByScope = new WeakMap<object, Set<SessionMcpRelayAcceptor>>();

/** Registers the Session MCP endpoint of `scope` for relays its target holders carry; returns the unregistration. */
export function registerSessionMcpRelayAcceptor(scope: object, acceptor: SessionMcpRelayAcceptor): () => void {
    let acceptors = sessionMcpRelayAcceptorsByScope.get(scope);
    if (!acceptors) sessionMcpRelayAcceptorsByScope.set(scope, acceptors = new Set());
    acceptors.add(acceptor);
    return () => { acceptors.delete(acceptor); };
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

/** One held Agent of a runner, as the daemon records it in the Session marker. */
export type SessionHeldAgentV1 = Omit<SessionHolderAdoptToken, 'turnId'> & Readonly<{ role: 'primary' }>;

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
     * Throws a typed refusal for anything the launch step did not place there.
     */
    prepareLaunch?(launch: Readonly<{ command: string; args: readonly string[]; cwd?: string }>): Readonly<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<Record<string, string>> }>;
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
    /** Windows: the args are a rendered command-line tail, appended unquoted. */
    windowsVerbatimArguments?: boolean;
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
            role: input.role, target: connectSessionTarget(placement) });
    }
    return Object.freeze({ kind: 'spawn', executablePath: requireSessionHolderExecutablePath(),
        socketPath: createSessionHolderSocketPath(), role: input.role });
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
    const heldAgentsV1 = [{ role: 'primary' as const, socketPath: child.socketPath, holderPid: child.holderPid, agentPid }];
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
 * A fresh per-launch holder address. POSIX: a 0700 per-user directory (checked
 * for ownership and mode) under `XDG_RUNTIME_DIR` or the OS temp dir, kept short
 * for the Unix socket path limit. Windows: a local named pipe; the holder sets an
 * owner-only DACL and rejects remote clients.
 */
export function createSessionHolderSocketPath(platform: NodeJS.Platform = process.platform): string {
    const id = randomBytes(12).toString('hex');
    if (platform === 'win32') return `\\\\.\\pipe\\happier-holder-${id}`;
    const uid = process.getuid?.() ?? 0;
    const base = process.env.XDG_RUNTIME_DIR && isOwnedPrivateDirectory(process.env.XDG_RUNTIME_DIR, uid)
        ? process.env.XDG_RUNTIME_DIR : tmpdir();
    const directory = join(base, `happier-holders-${uid}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!isOwnedPrivateDirectory(directory, uid)) {
        throw Object.assign(new Error('Session holder directory is not private to this user'), { code: 'session_holder_directory_unsafe' });
    }
    return join(directory, `${id}.sock`);
}

function isOwnedPrivateDirectory(path: string, uid: number): boolean {
    try {
        const stat = statSync(path);
        return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
    } catch {
        return false;
    }
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
export class SessionHolderStreamProcess extends EventEmitter {
    readonly stdin: Writable;
    readonly stdout = new Readable({ read() {} });
    readonly stderr = new Readable({ read() {} });
    streamId: number | undefined;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    private exited = false;

    constructor(private readonly holder: SessionHolderChild) {
        super();
        this.stdin = new Writable({
            write: (chunk: Buffer, _encoding, callback) => this.whenStarted(id => holder.sendStreamFrame('I', id, chunk, callback), callback),
            final: (callback) => this.whenStarted(id => holder.sendStreamFrame('C', id, new Uint8Array(), callback), callback),
        });
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
    kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
        if (this.streamId === undefined || this.exited) return false;
        void this.holder.request({ op: 'kill', stream: this.streamId, signal: holderSignalName(signal) });
        return true;
    }

    /** TERM, then KILL after `graceMs`, settled by the stream's exit frame. */
    async terminateTree(graceMs: number): Promise<void> {
        if (this.exited || this.streamId === undefined) return;
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
    async terminateGroup(options: Readonly<{ graceMs: number; firstSignal?: 'SIGKILL' }>): Promise<void> {
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
        void this.request(body)
            .then((reply) => {
                const value = reply.value as { stream?: unknown } | undefined;
                if (reply.ok !== true || typeof value?.stream !== 'number') {
                    const code = typeof reply.code === 'string' ? reply.code : typeof reply.error === 'string' ? reply.error : 'spawn_failed';
                    process.observeExit(null, null);
                    process.emit('error', Object.assign(new Error(`Session holder could not start ${label}`), { code, syscall: 'spawn' }));
                    return;
                }
                process.streamId = value.stream;
                this.streams.set(value.stream, process);
                process.once('exit', () => this.streams.delete(value.stream as number));
                process.emit('spawn');
                for (const [kind, body] of this.unclaimedStreamFrames.get(value.stream) ?? []) process.deliver(kind, body);
                this.unclaimedStreamFrames.delete(value.stream);
            });
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

    /** The Agent never started: queued input fails instead of waiting forever. */
    abandonPendingInput(error: Error): void {
        this.closed = true;
        for (const [, , callback] of this.pendingFrames.splice(0)) callback(error);
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
        const [acceptor] = sessionMcpRelayAcceptorsByScope.get(this.holderScope) ?? [];
        let options: { toolNameMaxLength?: unknown } = {};
        try { options = JSON.parse(body.toString('utf8')) as typeof options; } catch { /* no budget */ }
        const toolNameMaxLength = typeof options.toolNameMaxLength === 'number' ? options.toolNameMaxLength : undefined;
        if (acceptor) acceptor(relay, toolNameMaxLength === undefined ? {} : { toolNameMaxLength });
        else {
            logger.debug('[SessionHolder] Session MCP relay closed: no Session MCP endpoint in this runner');
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
    const holder = spawn(launch.executablePath, ['serve', '--socket', launch.socketPath,
        ...(launch.windowsVerbatimArguments ? ['--windows-verbatim'] : []), '--', launch.command, ...launch.args], {
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
    holder.once('exit', () => fail(Object.assign(new Error('Session holder ended before the Agent started'), { code: 'session_holder_failed' })));
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (chunk: string) => {
        if (settled) return;
        line += chunk;
        const end = line.indexOf('\n');
        if (end < 0) return;
        const ready = JSON.parse(line.slice(0, end)) as { ready: boolean; agentPid?: number; holderPid?: number; code?: string; kind?: string; errno?: number | null; message?: string };
        if (!ready.ready || typeof ready.agentPid !== 'number') {
            fail(spawnFailureError(ready));
            return;
        }
        Object.defineProperty(child, 'pid', { value: ready.agentPid, writable: true, configurable: true });
        connectHolder(child, () => {
            if (settled) return;
            settled = true;
            holder.removeAllListeners('exit');
            holder.stdout.destroy();
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
    let prepared: Readonly<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<Record<string, string>> }>;
    try {
        prepared = target.prepareLaunch
            ? target.prepareLaunch({ command: launch.command, args: launch.args, ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}) })
            : { command: launch.command, args: launch.args, ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}), env: {} };
    } catch (error) {
        process.nextTick(() => fail(error instanceof Error ? error : new Error(String(error))));
        return child;
    }
    const environment = Object.entries(prepared.env).map(([name, value]) => `${name}=${value}`);
    const argv = [...(environment.length ? ['env', ...environment] : []), prepared.command, ...prepared.args];
    const ready = `${launch.socketPath}.ready`;
    const command = ['umask 077', `rm -f ${q(ready)}`, `mkfifo ${q(ready)}`,
        ...(prepared.cwd ? [`cd ${q(prepared.cwd)}`] : []),
        // The primary Agent's Session MCP relays reach this Machine through its holder (`--session-mcp`).
        `nohup ${q(target.holderPath)} serve --socket ${q(launch.socketPath)}${launch.role === 'primary' ? ' --session-mcp' : ''} -- ${argv.map(q).join(' ')} >${q(ready)} 2>/dev/null </dev/null &`,
        `head -n 1 ${q(ready)}`, `rm -f ${q(ready)}`].join('\n');
    void target.exec(command).then((result) => {
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
        client.abandonPendingInput(error);
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
