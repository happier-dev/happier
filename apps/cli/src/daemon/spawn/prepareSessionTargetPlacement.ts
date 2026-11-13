import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, sep } from 'node:path';
import type { ManagedSessionTarget, ManagedSessionTargetRequest } from '@/machines/managed/acquire';
import { planAgentCliInstallForRuntime, type AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createSessionHolderSocketPath, readAdoptableHolderHello, type SessionHeldAgentV1 } from '@/subprocess/supervision/sessionHolder';
import { readSessionTargetHolderArtifacts } from '@/subprocess/supervision/sessionHolderTargetArtifacts';
import { createTargetHolderSocketPath, serveSessionTargetRelay, type SessionTargetLaunch, type SessionTargetPlacement } from '@/subprocess/supervision/sessionTargetRelay';

export type OpenManagedSessionTarget = (request: ManagedSessionTargetRequest) => Promise<ManagedSessionTarget>;

/** Target acquisition/material delivery refused before any runner exists. */
export function projectSessionTargetLaunchFailure(error?: unknown): Extract<SpawnSessionResult, { type: 'error' }> {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'managed_target_unavailable';
    return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: code, errorDetail: { kind: 'launch_error', code, message: code } };
}

/**
 * Spawn step for a Session placed on a managed target (no daemon inside it):
 * the target's custody stays with this daemon (the managed driver), the runner
 * gets only the relay address in its placement. The placement's lifetime is the
 * launch's resources: a refused/failed spawn retires it at once, a launched
 * Session's resources retire when it exits, so the authority, every channel and
 * the relay end with the Session.
 */
export async function prepareSessionTargetPlacement(input: Readonly<{
    request: Readonly<{ managedId: string }>;
    /** Stable for this spawn (the tracking key / nonce); names the authority. */
    sessionKey: string;
    requesterAccountId: string | null;
    holderVersion: string;
    openManagedSessionTarget?: OpenManagedSessionTarget;
    launchResourceScope: ProviderLaunchResourceScope;
    /** The Session runner's pid once launched (the relay admits only that process); `null` before. */
    readTrustedCallerPid(): number | null;
    socketPath?: string;
    /** A respawn adopting the crashed runner's held primary Agent: its holder's address in the target. */
    primarySocketPath?: string;
}>): Promise<Readonly<{ ok: true; placement: SessionTargetPlacement; target: ManagedSessionTarget; signal: AbortSignal;
    /** The Session's plain target key (names its guest directory and authority). */
    sessionKey: string }> | Readonly<{ ok: false; result: Extract<SpawnSessionResult, { type: 'error' }> }>> {
    const sessionKey = plainSessionTargetKey(input.sessionKey);
    const refused = (error?: unknown) => ({ ok: false as const, result: projectSessionTargetLaunchFailure(error) });
    if (!input.openManagedSessionTarget || !input.requesterAccountId) return refused();
    const lifetime = new AbortController();
    input.launchResourceScope.register(() => lifetime.abort());
    try {
        const target = await input.openManagedSessionTarget({ managedId: input.request.managedId, sessionId: sessionKey,
            requesterAccountId: input.requesterAccountId, lifetime: lifetime.signal,
            holder: { version: input.holderVersion, resolveArtifacts: readSessionTargetHolderArtifacts } });
        const relay = await serveSessionTargetRelay({ operations: target, lifetime: lifetime.signal, readTrustedCallerPid: input.readTrustedCallerPid,
            socketPath: input.socketPath ?? createSessionHolderSocketPath() });
        return { ok: true, target, signal: lifetime.signal, sessionKey, placement: { id: target.id, holderPath: target.holderPath,
            socketDirectory: target.socketDirectory, relaySocketPath: relay.socketPath, primarySocketPath: input.primarySocketPath ?? createTargetHolderSocketPath(target) } };
    } catch (error) {
        lifetime.abort();
        return refused(error);
    }
}

/**
 * Spawn keys are a nonce, a Session id or an Action's stable nonce
 * (`session.spawn_new.creation:<hash>`); a guest directory name takes a plain
 * key: kept when already plain, otherwise its sha256 (stable per spawn key).
 */
function plainSessionTargetKey(key: string): string {
    return /^[A-Za-z0-9._-]+$/u.test(key) && key !== '.' && key !== '..' ? key : createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function refusal(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function isWithin(root: string, path: string): string | null {
    const rest = relative(root, path);
    return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)) ? rest : null;
}

/** ELF `e_machine` → Node arch for the static Agent CLIs a Linux target can run (anything else is not placeable). */
async function readElfArch(path: string): Promise<'x64' | 'arm64' | null> {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(20);
        const { bytesRead } = await handle.read(header, 0, 20, 0);
        if (bytesRead < 20 || header.readUInt32BE(0) !== 0x7f454c46) return null;
        const machine = header.readUInt16LE(18);
        return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : null;
    } finally { await handle.close(); }
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const path = prefix ? join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) files.push(...await listFiles(root, path));
        else if (entry.isFile()) files.push(path);
        // Links and special files are not part of an Agent home a target can use; never followed.
    }
    return files;
}

/** Session keys this daemon is placing or running on targets (their guest directories are never swept). */
const activeSessionTargetKeys = new Set<string>();

/** Removes Session directories no Agent holds (`.live` lock free) and this daemon is not placing. */
function sweepEndedSessionsCommand(sessions: string): string {
    const q = safeBashSingleQuote;
    const keep = [...activeSessionTargetKeys].map(key => ` ${key} `).join('');
    return `cd ${q(sessions)} 2>/dev/null || exit 0; for d in */; do k=\${d%/}; case ${q(keep)} in *" $k "*) continue;; esac; `
        + `if flock -n -x "$k/.live" true 2>/dev/null; then rm -rf -- "$k"; fi; done; exit 0`;
}

/**
 * A crashed runner's held primary Agent of a placed Session (its pids are the
 * target's): probed for adoption, or ended when the respawn gives up, under a
 * short Session authority of its own (the crashed runner's ended with it).
 * Ending signals the Agent's process group and its holder in the target, then
 * sweeps the Session directories no Agent holds any more.
 */
export async function reachHeldTargetAgent(input: Readonly<{
    request: Readonly<{ managedId: string }>;
    sessionKey: string;
    requesterAccountId: string | null;
    holderVersion: string;
    openManagedSessionTarget?: OpenManagedSessionTarget;
    held: SessionHeldAgentV1;
    action: 'probe' | 'end';
}>): Promise<boolean> {
    if (!input.openManagedSessionTarget || !input.requesterAccountId) return false;
    const lifetime = new AbortController();
    try {
        const target = await input.openManagedSessionTarget({ managedId: input.request.managedId, sessionId: input.sessionKey,
            requesterAccountId: input.requesterAccountId, lifetime: lifetime.signal,
            holder: { version: input.holderVersion, resolveArtifacts: readSessionTargetHolderArtifacts } });
        if (input.action === 'probe') {
            return await readAdoptableHolderHello(target.openChannel([target.holderPath, 'attach', '--socket', input.held.socketPath], lifetime.signal), input.held);
        }
        const { agentPid, holderPid } = input.held;
        await target.exec(`kill -TERM -- -${agentPid} 2>/dev/null; kill -TERM ${agentPid} ${holderPid} 2>/dev/null; `
            + `command -v flock >/dev/null 2>&1 || exit 0; ${sweepEndedSessionsCommand(posix.join(target.home, '.happier', 'sessions'))}`, lifetime.signal);
        return true;
    } catch {
        return false;
    } finally {
        lifetime.abort();
    }
}

async function hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

/**
 * The launch step for a Session placed on a target (ONE-DAEMON-SANDBOXES: the
 * one explicit exception to "no credentials inside"): only this Session's own
 * Agent credentials cross, never Happier auth or Account keys, and only for the
 * Session's life.
 * - Credentials: only the entries the provider owner declares as its auth
 *   material (`authIsolation.secretEntries` of its native-home descriptor) are
 *   copied from the Session's materialized Agent home to
 *   `~/.happier/sessions/<key>/agent-home`; config, hooks, MCP settings and
 *   plugins never cross. Runner env entries pointing into that home are
 *   rewritten there; no other env crosses (values would sit in the guest's
 *   process list).
 * - Lifetime: the guest directory is removed by a cleanup on the launch's
 *   resource scope (registered after the authority's end, so it runs first,
 *   while the authority is still live). Leftovers of Sessions that ended without
 *   cleanup (daemon crash) are swept when a later Session is placed: a directory
 *   is stale when no Agent holds its `.live` lock (`flock`, held shared by every
 *   Agent of the Session for its life) and this daemon is not placing it.
 * - Agent CLI: placed when it is a Linux ELF for the target's arch, once per
 *   content digest (`~/.happier/agent-cli/<sha256>/`, shared by Sessions),
 *   streamed through the provider channel and verified in the guest with the
 *   digest computed here from the bytes sent. The guest's own `sha256sum`
 *   checks transport only: the guest user can replace files it owns.
 *   Otherwise (a launcher script, another architecture) the provider's own
 *   Linux install recipe (`planAgentCliInstallForRuntime`, the install owner)
 *   runs in the target as its user, once per target, with this Session's
 *   delivered credential environment (vendor installers that download with the
 *   login, e.g. Muse, need it); the installed CLI is found in the provider's
 *   declared user bin directories.
 * - A request-auth materialization (a loopback proxy on this Machine) cannot be
 *   reached from a target: typed refusal.
 */
export async function deliverSessionTargetLaunch(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'home' | 'platform' | 'exec' | 'putFile' | 'openChannel'>;
    sessionKey: string;
    runnerEnvironment: Readonly<Record<string, string>>;
    materializedRoot: string | null;
    /** The provider owner's auth entries (top-level names in the Agent home); required when a home is materialized. */
    credentialEntries: readonly string[] | null;
    requestAuthMaterializedRoot: string | null;
    agentCommand: string | null;
    /** The Agent's CLI descriptor (catalog): its Linux install recipe when this Machine's CLI cannot run in the target. */
    agentRuntime?: AgentCliRuntimeDescriptor | null;
    workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
    launchResourceScope: Pick<ProviderLaunchResourceScope, 'register'>;
    signal?: AbortSignal;
}>): Promise<SessionTargetLaunch> {
    const signal = input.signal ?? new AbortController().signal;
    if (input.requestAuthMaterializedRoot) {
        throw refusal('connected_service_target_unsupported', 'This Agent credential is served on this Machine only and cannot reach a Session target');
    }
    if (input.materializedRoot && !input.credentialEntries?.length) {
        throw refusal('connected_service_target_unsupported', 'This Agent does not declare which credential files a Session target needs');
    }
    if (!/^[A-Za-z0-9._-]+$/u.test(input.sessionKey)) throw refusal('invalid_request', 'Session target key is not a plain name');
    const q = safeBashSingleQuote;
    const sessions = posix.join(input.target.home, '.happier', 'sessions');
    const base = posix.join(sessions, input.sessionKey);
    const run = async (command: string) => {
        const result = await input.target.exec(command, signal);
        if (result.status !== 0) throw refusal('provider_unavailable', 'A Session target launch command failed in the guest');
        return result.stdout;
    };
    activeSessionTargetKeys.add(input.sessionKey);
    let locking = false;
    // The Session's end (or its runner's crash) removes the directory unless an Agent of the Session still holds
    // it: a crashed runner's spared Agent keeps its credentials for the respawned runner that adopts it.
    input.launchResourceScope.register(async () => {
        try { await input.target.exec(locking ? `if flock -n -x ${q(`${base}/.live`)} true 2>/dev/null; then rm -rf ${q(base)}; fi` : `rm -rf ${q(base)}`, signal); }
        finally { activeSessionTargetKeys.delete(input.sessionKey); }
    });
    locking = (await run('command -v flock >/dev/null 2>&1 && echo flock || true')).trim() === 'flock';
    if (locking) await run(sweepEndedSessionsCommand(sessions));
    await run(`umask 077; mkdir -p ${q(`${base}/agent-home`)}`);

    const env: Record<string, string> = {};
    if (input.materializedRoot) {
        const root = input.materializedRoot;
        const allowed = new Set(input.credentialEntries);
        const files = (await listFiles(root)).filter(file => allowed.has(file.split(sep)[0]!));
        const directories = [...new Set(files.map(file => posix.dirname(posix.join(base, 'agent-home', ...file.split(sep)))))];
        if (directories.length) await run(`umask 077; mkdir -p ${directories.map(q).join(' ')}`);
        for (const file of files) {
            await input.target.putFile(posix.join(base, 'agent-home', ...file.split(sep)), await readFile(join(root, file)), signal);
        }
        for (const [name, value] of Object.entries(input.runnerEnvironment)) {
            const rest = isAbsolute(value) ? isWithin(root, value) : null;
            if (rest !== null) env[name] = rest ? posix.join(base, 'agent-home', ...rest.split(sep)) : posix.join(base, 'agent-home');
        }
    }

    const executables: Record<string, string> = {};
    if (input.agentCommand) {
        const arch = await readElfArch(input.agentCommand).catch(() => null);
        if (input.target.platform.os !== 'linux' || arch !== input.target.platform.arch) {
            executables[input.agentCommand] = await installAgentCliInTarget({ target: input.target, runtime: input.agentRuntime ?? null, env, signal });
            return { executables, env, workspace: input.workspace, ...(locking ? { lockPath: posix.join(base, '.live') } : {}) };
        }
        const digest = await hashFile(input.agentCommand);
        const directory = posix.join(input.target.home, '.happier', 'agent-cli', digest);
        const placed = posix.join(directory, basename(input.agentCommand));
        const present = (await input.target.exec(`sha256sum ${q(placed)} 2>/dev/null | cut -d' ' -f1`, signal)).stdout.trim();
        if (present !== digest) {
            const staged = `${placed}.${input.sessionKey}.staged`;
            await run(`umask 077; mkdir -p ${q(directory)}`);
            // Too large for one provider file put: stream it through the channel, then verify in the guest.
            const channel = input.target.openChannel(['sh', '-c', 'umask 077 && cat > "$1"', 'sh', staged], signal);
            await new Promise<void>((resolve, reject) => {
                channel.once('error', reject);
                channel.once('close', () => resolve());
                channel.resume();
                createReadStream(input.agentCommand!).once('error', reject).pipe(channel);
            });
            const verified = await run(`if [ "$(sha256sum ${q(staged)} | cut -d' ' -f1)" = ${q(digest)} ]; then chmod 700 ${q(staged)} && mv -f ${q(staged)} ${q(placed)} && echo promoted; else rm -f ${q(staged)}; echo mismatch; fi`);
            if (verified.trim() !== 'promoted') throw refusal('agent_cli_target_unavailable', 'The Agent CLI did not verify in the Session target');
        }
        executables[input.agentCommand] = placed;
    }
    return { executables, env, workspace: input.workspace, ...(locking ? { lockPath: posix.join(base, '.live') } : {}) };
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * The provider's Linux install recipe run in the target (the guest user's own
 * install, like an Agent install on a member Machine): reused when the CLI is
 * already in one of the provider's declared user bin directories. Only
 * no-admin vendor recipes run there; a managed package needs this Machine's
 * runtime and is not placeable.
 */
async function installAgentCliInTarget(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'home' | 'platform' | 'exec'>;
    runtime: AgentCliRuntimeDescriptor | null;
    env: Readonly<Record<string, string>>;
    signal: AbortSignal;
}>): Promise<string> {
    const { platform } = input.target;
    const unavailable = (detail: string) => refusal('agent_cli_target_unavailable', `This Agent CLI cannot run in a ${platform.os}-${platform.arch} target: ${detail}`);
    const planned = input.runtime && platform.os === 'linux' ? planAgentCliInstallForRuntime({ runtimeSpec: input.runtime, platform: 'linux' }) : null;
    if (!input.runtime || !planned?.ok || planned.plan.installMode !== 'vendor_recipe' || planned.plan.requiresAdmin) {
        throw unavailable('this Machine\'s CLI is not a Linux executable for it and the Agent has no Linux install recipe a target user can run');
    }
    const q = safeBashSingleQuote;
    const binDirectories = (input.runtime.knownUserBinDirSuffixes ?? []).map(suffix => posix.join(input.target.home, suffix));
    const prelude = [`export HOME=${q(input.target.home)}`,
        ...Object.entries(input.env).filter(([name]) => SHELL_NAME.test(name)).map(([name, value]) => `export ${name}=${q(value)}`),
        ...(binDirectories.length ? [`export PATH=${q(binDirectories.join(':'))}:"$PATH"`] : []), 'cd "$HOME"'].join('; ');
    const locate = async () => (await input.target.exec(`${prelude}; command -v ${q(input.runtime!.binaryName)} || true`, input.signal)).stdout.trim();
    const present = await locate();
    if (present.startsWith('/')) return present;
    for (const step of planned.plan.commands) {
        const runnable = (await input.target.exec(`${prelude}; command -v ${q(step.cmd)} >/dev/null 2>&1 && echo yes`, input.signal)).stdout.trim();
        if (runnable !== 'yes') throw unavailable(`its install recipe needs \`${step.cmd}\` in the target`);
        const result = await input.target.exec(`${prelude}; ${[step.cmd, ...step.args].map(q).join(' ')}`, input.signal);
        if (result.status !== 0) {
            throw unavailable(result.status === 127 ? 'its install recipe needs a command the target does not have' : 'its install recipe failed in the target');
        }
    }
    const installed = await locate();
    if (!installed.startsWith('/')) throw unavailable('its install recipe did not install the CLI where the Agent declares it');
    return installed;
}
