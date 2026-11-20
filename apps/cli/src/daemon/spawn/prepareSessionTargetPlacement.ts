import { createHash } from 'node:crypto';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { projectSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import type { ManagedSessionTarget, ManagedSessionTargetRequest } from '@/machines/managed/acquire';
import { writeManagedChannelFile } from '@/machines/managed/channelFileDelivery';
import { execWithManagedChannelEnvironment } from '@/machines/managed/channelEnvironmentDelivery';
import { installAgentCliForTarget, planAgentCliInstallForRuntime, type AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { REMOTE_SHA256_FILE_FUNCTION, safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { readExecutablePlatform } from '@happier-dev/cli-common/process';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/composition/executableTypes';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createSessionHolderSocketPath, isSessionHolderSocketPath, readAdoptableHolderHello, type SessionHeldAgentV1 } from '@/subprocess/supervision/sessionHolder';
import { readSessionTargetHolderArtifacts } from '@/subprocess/supervision/sessionHolderTargetArtifacts';
import { assertSessionTargetWorkspaceUnambiguous, createTargetHolderSocketPath, serveSessionTargetRelay, type SessionTargetLaunch, type SessionTargetPlacement } from '@/subprocess/supervision/sessionTargetRelay';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '@/daemon/types';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { ActionOperationProgressUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import type { SessionProjectFilesSourceV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import type { ResolvedSessionProjectFilesV1 as SessionProjectFilesV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import type { WorkspaceManifest } from '@happier-dev/protocol/workspaces/manifestSchema';
import type { WorkspaceContentPolicyV1 } from '@happier-dev/protocol';
import type { WorkspaceAddressV1, WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { registerSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

export type OpenManagedSessionTarget = (request: ManagedSessionTargetRequest) => Promise<ManagedSessionTarget>;

/** Target acquisition/material delivery refused before any runner exists. */
export function projectSessionTargetLaunchFailure(error?: unknown): Extract<SpawnSessionResult, { type: 'error' }> {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'managed_target_unavailable';
    const failure = normalizeActionExecutorThrownError(error, 'session.target.prepare');
    const cause = projectSessionRuntimeFailureCause(error, 'client_start', 'session.target.prepare');
    const message = failure.errorCode === code ? failure.error : code;
    return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: message, errorDetail: { kind: 'launch_error', code, message,
            ...(cause ? { failureCause: { ...cause, ...(failure.requestId ? { requestId: failure.requestId } : {}) } } : {}) } };
}

/**
 * Spawn step for a Session placed on a managed target (no daemon inside it):
 * the target's custody stays with this daemon (the managed driver), the runner
 * gets only the relay address in its placement. A refused/failed spawn ends the
 * placement at once; a launched Session's placement ends when its runner has
 * exited (also when a Stop retired the launch resources first: the runner stops
 * its target Agents through their holders over this relay). Its end runs the
 * `onSessionEnd` steps, then the authority, every channel and the relay end.
 */
export async function prepareSessionTargetPlacement(input: Readonly<{
    request: Readonly<{ managedId: string }>;
    /** Stable for this spawn (the tracking key / nonce); names the authority. */
    sessionKey: string;
    committedSessionId?: ManagedSessionTargetRequest['committedSessionId'];
    requesterAccountId: string | null;
    holderVersion: string;
    openManagedSessionTarget?: OpenManagedSessionTarget;
    operation?: ManagedSessionTargetRequest['operation'];
    launchResourceScope: ProviderLaunchResourceScope;
    /** The Session runner's pid once launched (the relay admits only that process); `null` before. */
    readTrustedCallerPid(): number | null;
    socketPath?: string;
    /** A respawn adopting the crashed runner's held primary Agent: its holder's address in the target. */
    primarySocketPath?: string;
    /** Settles once the Session's runner process has exited (the tracked Session ended). */
    runnerExit: Promise<void>;
}>): Promise<Readonly<{ ok: true; placement: SessionTargetPlacement; target: ManagedSessionTarget; signal: AbortSignal;
    /** The Session's plain target key (names its guest directory and authority). */
    sessionKey: string;
    /** A step of the Session's end in the target, run (latest first) while the target authority is still live. */
    onSessionEnd(step: () => Promise<void>): void }> | Readonly<{ ok: false; result: Extract<SpawnSessionResult, { type: 'error' }> }>> {
    const sessionKey = plainSessionTargetKey(input.sessionKey);
    const refused = (error?: unknown) => ({ ok: false as const, result: projectSessionTargetLaunchFailure(error) });
    if (!input.openManagedSessionTarget || !input.requesterAccountId) return refused();
    const lifetime = new AbortController();
    const endSteps: Array<() => Promise<void>> = [];
    let ending: Promise<void> | undefined;
    const end = () => ending ??= (async () => {
        for (const step of [...endSteps].reverse()) {
            await step().catch((error: unknown) => logger.warn('[DAEMON RUN] Session target end step failed',
                { code: (error as { code?: unknown })?.code ?? 'session_target_unavailable' }));
        }
        lifetime.abort();
    })();
    input.launchResourceScope.register({ onFailure: end,
        // A Stop retires launch resources before it signals the runner, and the runner stops its Agents through
        // their holders over this relay (no target pid is local): the authority ends once the runner has exited.
        onExit: () => { void input.runnerExit.then(end); } });
    try {
        const target = await input.openManagedSessionTarget({ managedId: input.request.managedId, sessionId: sessionKey,
            ...(input.committedSessionId ? { committedSessionId: input.committedSessionId } : {}),
            requesterAccountId: input.requesterAccountId, lifetime: lifetime.signal,
            ...(input.operation ? { operation: input.operation } : {}),
            holder: { version: input.holderVersion, resolveArtifacts: readSessionTargetHolderArtifacts } });
        const relay = await serveSessionTargetRelay({ operations: target, lifetime: lifetime.signal, readTrustedCallerPid: input.readTrustedCallerPid,
            socketPath: input.socketPath ?? createSessionHolderSocketPath() });
        return { ok: true, target, signal: lifetime.signal, sessionKey, onSessionEnd: step => { endSteps.push(step); }, placement: { id: target.id, holderPath: target.holderPath, helperPath: target.helperPath,
            socketDirectory: target.socketDirectory, relaySocketPath: relay.socketPath, primarySocketPath: input.primarySocketPath ?? createTargetHolderSocketPath(target) } };
    } catch (error) {
        lifetime.abort();
        return refused(error);
    }
}

/**
 * When a placed Session's runner has exited, so its target may end (a Stop retires
 * launch resources before it signals the runner, which stops its Agents through the
 * target). A Session in the daemon's session host has no process of its own: its end
 * is the host's end of that Session (`hostedSession.observed`). A runner process: its
 * `exit`. Without either (a runner this daemon only observes) the exit is already
 * the caller's fact.
 */
export function observeSessionTargetRunnerExit(runner: Readonly<Pick<TrackedSession, 'childProcess' | 'hostedSession'>>): Promise<void> {
    if (runner.hostedSession) return runner.hostedSession.observed;
    const child = runner.childProcess;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => { child.once('exit', () => resolve()); });
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
    return Object.assign(new Error(message, { cause: { ok: false, errorCode: code, error: message } }), { code });
}

function isWithin(root: string, path: string): string | null {
    const rest = relative(root, path);
    return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)) ? rest : null;
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
function sweepEndedSessionsCommand(sessions: string, helperPath: string): string {
    const q = safeBashSingleQuote;
    const keep = [...activeSessionTargetKeys].map(key => ` ${key} `).join('');
    return `cd ${q(sessions)} 2>/dev/null || exit 0; for d in */; do k=\${d%/}; case ${q(keep)} in *" $k "*) continue;; esac; `
        + `if ${q(helperPath)} file-lock -n -x "$k/.live" -- true 2>/dev/null; then rm -rf -- "$k"; fi; done; exit 0`;
}

type SessionTargetAuthorityRequest = Readonly<{
    request: Readonly<{ managedId: string }>;
    sessionKey: string;
    committedSessionId?: ManagedSessionTargetRequest['committedSessionId'];
    requesterAccountId: string | null;
    holderVersion: string;
    openManagedSessionTarget?: OpenManagedSessionTarget;
}>;

/** A Session authority of the daemon's own for a placed Session it did not place (reattached or crashed runner). */
function openSessionTargetAuthority(input: SessionTargetAuthorityRequest, lifetime: AbortSignal): Promise<ManagedSessionTarget> | null {
    if (!input.openManagedSessionTarget || !input.requesterAccountId) return null;
    return input.openManagedSessionTarget({ managedId: input.request.managedId, sessionId: input.sessionKey,
        ...(input.committedSessionId ? { committedSessionId: input.committedSessionId } : {}),
        requesterAccountId: input.requesterAccountId, lifetime,
        holder: { version: input.holderVersion, resolveArtifacts: readSessionTargetHolderArtifacts } });
}

/**
 * After a daemon restart, a reattached placed Session's runner still lives but
 * its relay ended with the previous daemon: the relay is served again at the
 * address the runner's placement names (one this Machine's holder directory
 * hands out), admitting only that runner, under a Session authority of this
 * daemon's own. Returns its release (authority, channels and socket end), or
 * `null` when the target cannot be reached (the caller keeps today's end of the
 * stranded Agent at the runner's exit).
 */
export async function restoreSessionTargetRelay(input: SessionTargetAuthorityRequest & Readonly<{
    socketPath: string;
    readTrustedCallerPid(): number | null;
    onRestored?(target: ManagedSessionTarget): void;
    workspace?: Readonly<{ sessionId: string; primarySocketPath: string;
        roots: Readonly<{ hostRoot: string; targetRoot: string }>;
        readBaseline?(signal: AbortSignal): Promise<WorkspaceManifest | null> }>;
}>): Promise<(() => void) | null> {
    if (!isSessionHolderSocketPath(input.socketPath)) return null;
    const lifetime = new AbortController();
    try {
        const target = await openSessionTargetAuthority(input, lifetime.signal);
        if (!target) return null;
        await serveSessionTargetRelay({ operations: target, lifetime: lifetime.signal, readTrustedCallerPid: input.readTrustedCallerPid, socketPath: input.socketPath });
        if (input.workspace) {
            const { sessionId, primarySocketPath, roots, readBaseline } = input.workspace;
            const baseline = await readBaseline?.(lifetime.signal);
            registerSessionTargetWorkspace({ sessionId, lifetime: lifetime.signal, primarySocketPath,
                target: { id: target.id, lifetime: target.lifetime, holderPath: target.holderPath, helperPath: target.helperPath, socketDirectory: target.socketDirectory,
                    exec: command => target.exec(command, lifetime.signal), openChannel: argv => target.openChannel(argv, lifetime.signal) },
                workspace: roots,
                ...(baseline ? { baseline } : {}) });
        }
        input.onRestored?.(target);
        return () => lifetime.abort();
    } catch (error) {
        lifetime.abort();
        logger.warn('[DAEMON RUN] Session target relay could not be served again', { code: (error as { code?: unknown })?.code ?? 'session_target_unavailable' });
        return null;
    }
}

/**
 * A crashed runner's held primary Agent of a placed Session (its pids are the
 * target's): probed for adoption, or ended when the respawn gives up, under a
 * short Session authority of its own (the crashed runner's ended with it).
 * Ending signals the Agent's process group and its holder in the target, then
 * sweeps the Session directories no Agent holds any more.
 */
export async function reachHeldTargetAgent(input: SessionTargetAuthorityRequest & Readonly<{
    held: SessionHeldAgentV1;
    action: 'probe' | 'end';
}>): Promise<boolean> {
    const lifetime = new AbortController();
    try {
        const target = await openSessionTargetAuthority(input, lifetime.signal);
        if (!target) return false;
        if (input.action === 'probe') {
            return await readAdoptableHolderHello(target.openChannel([target.holderPath, 'attach', '--socket', input.held.socketPath], lifetime.signal), input.held);
        }
        const { agentPid, holderPid } = input.held;
        await target.exec(`kill -TERM -- -${agentPid} 2>/dev/null; kill -TERM ${agentPid} ${holderPid} 2>/dev/null; `
            + sweepEndedSessionsCommand(posix.join(target.home, '.happier', 'sessions'), target.helperPath), lifetime.signal);
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
 *   material (`authIsolation.secretEntries` of its native-home descriptor: paths
 *   relative to the native home, a file or a credential directory, e.g. Muse's
 *   `muse/auth.json`, Codex's `accounts`) are copied from the Session's materialized Agent home to
 *   `~/.happier/sessions/<key>/agent-home`; config, hooks, MCP settings and
 *   plugins never cross. Runner env entries pointing into that home are
 *   rewritten there. Selected Provider/materializer environment names accompany
 *   placement; admitted values cross only through the private stdin file publisher.
 * - Lifetime: the guest directory is removed by a Session-end step of the
 *   placement (it runs before the authority ends). Leftovers of Sessions that ended without
 *   cleanup (daemon crash) are swept when a later Session is placed: a directory
 *   is stale when no Agent holds its `.live` lock (held shared by every
 *   Agent of the Session for its life) and this daemon is not placing it.
 * - Agent CLI: placed when it is a native executable for the target's OS and arch, once per
 *   content digest (`~/.happier/agent-cli/<sha256>/`, shared by Sessions),
 *   streamed through the provider channel and verified in the guest with the
 *   digests computed here from the bytes sent. The guest's SHA-256 utility
 *   checks transport only: the guest user can replace files it owns.
 *   Otherwise, when the Agent's CLI ships as a GitHub release (catalog
 *   `github_release_binary`), the release for the target's platform and
 *   architecture is staged on this Machine by the install owner
 *   (`installAgentCliForTarget`: same asset declaration, digest-verified
 *   download and promotion as this Machine's managed install, under
 *   `tools/targets/<os>-<arch>/`, once per Machine) and every declared file of
 *   it is placed the same way. Otherwise (a launcher script, no release for
 *   it) the provider's own install recipe (`planAgentCliInstallForRuntime`)
 *   runs in the target as its user, once per target, with this Session's
 *   delivered credential environment (vendor installers that download with the
 *   login, e.g. Muse, need it); the installed CLI is found in the provider's
 *   declared user bin directories.
 * - A request-auth materialization (a loopback proxy on this Machine) cannot be
 *   reached from a target: typed refusal.
 */
export async function deliverSessionTargetLaunch(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'id' | 'holderPath' | 'home' | 'platform' | 'helperPath' | 'exec' | 'putFile' | 'openChannel' | 'agentEnvironment'>;
    sessionKey: string;
    runnerEnvironment: Readonly<Record<string, string>>;
    providerEnvironmentKeys?: readonly string[];
    materializedRoot: string | null;
    requestAuthMaterializedRoot: string | null;
    agentCommand: string | null;
    /**
     * The Session's Agent in the spawn's leased runtime catalog: its declared auth entries (required when a home is
     * materialized) and its CLI descriptor (the install recipe when this Machine's CLI cannot run in the target).
     */
    agent: Readonly<{ id: string; catalog: SessionTargetAgentCatalog }> | null;
    workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
    /** The admitted Project files choice; absent selection means Copy once. */
    projectFiles?: Readonly<{ selection?: SessionProjectFilesV1; activeServerDir: string; registry?: ScmBackendRegistry;
        onProgress?(progress: ActionOperationProgressUpdate): void;
        projectFilesSource?: SessionProjectFilesSourceV1;
        projectFilesSourceWorkspace?: WorkspaceAddressV1;
        prepareSource?(input: Readonly<{ sourceWorkspace: WorkspaceAddressV1; targetRootPath: string; contentPolicy?: WorkspaceContentPolicyV1; signal: AbortSignal }>):
            Promise<Readonly<{ targetRootPath: string; baseline?: WorkspaceManifest; targetWorkspace?: WorkspaceAddressV2;
                contentPolicyDigest?: WorkspaceContentPolicyV1['policyDigest'] }>>;
        onWorkspaceSeed?(baseline: WorkspaceManifest | undefined, targetWorkspace?: WorkspaceAddressV2,
            contentPolicyDigest?: WorkspaceContentPolicyV1['policyDigest']): void;
        prepareSync?(input: Readonly<{ sourceRootPath: string; targetRootPath: string; contentPolicy?: WorkspaceContentPolicyV1;
            mode: Extract<SessionProjectFilesV1, { kind: 'sync' }>['mode']; signal: AbortSignal }>): Promise<Readonly<{
                relationshipId: string; targetWorkspace?: WorkspaceAddressV2; contentPolicyDigest?: WorkspaceContentPolicyV1['policyDigest'] }>> }>;
    /** The placement's Session-end steps (`prepareSessionTargetPlacement`). */
    onSessionEnd(step: () => Promise<void>): void;
    /** This Machine's environment for staging a release for the target (managed tools root, GitHub token); GitHub is the boundary. */
    agentCliInstall?: Readonly<{ env?: NodeJS.ProcessEnv; deps?: Parameters<typeof installAgentCliForTarget>[0]['deps'] }>;
    signal?: AbortSignal;
}>): Promise<SessionTargetLaunch> {
    const signal = input.signal ?? new AbortController().signal;
    if (input.requestAuthMaterializedRoot) {
        throw refusal('connected_service_target_unsupported', 'This Agent credential is served on this Machine only and cannot reach a Session target');
    }
    const { credentialEntries, runtime } = await readSessionTargetAgent(input.agent);
    if (input.materializedRoot && !credentialEntries?.length) {
        throw refusal('connected_service_target_unsupported', 'This Agent does not declare which credential files a Session target needs');
    }
    if (!/^[A-Za-z0-9._-]+$/u.test(input.sessionKey)) throw refusal('invalid_request', 'Session target key is not a plain name');
    let workspace = input.workspace;
    if (input.projectFiles) {
        if (input.projectFiles.selection?.kind === 'sync' && !input.projectFiles.prepareSync) {
            throw refusal('project_files_mode_unavailable', 'This Project files mode is unavailable for the target');
        }
        const targetPathForRoot = (root: string) => posix.join(input.target.home, '.happier', 'workspaces', createHash('sha256').update(root).digest('hex'));
        if (input.projectFiles.selection?.kind === 'git_clone') {
            const { source, branch } = input.projectFiles.selection;
            const identity = normalizeScmHostingRepositoryIdentity({ kind: source.provider.kind,
                deployment: source.provider.baseUrl, repository: source.repository.nameWithOwner });
            const targetPath = targetPathForRoot(JSON.stringify({ repository: identity, branch }));
            const { inspectManagedWorkspaceSyncSeedTarget } = await import('@/workspaces/sync/materializeManagedWorkspaceSyncSeed');
            workspace = { hostRoot: input.workspace.hostRoot, targetRoot: targetPath };
            if (await inspectManagedWorkspaceSyncSeedTarget({ target: input.target, targetPath, signal }) === 'copy') {
                const { materializeManagedProjectClone } = await import('@/scm/rpc/repositoryProvisioningDispatch');
                const materialized = await materializeManagedProjectClone({ target: input.target,
                    selection: input.projectFiles.selection, destinationParentPath: posix.dirname(targetPath),
                    destinationDirectoryName: posix.basename(targetPath), registry: input.projectFiles.registry, signal });
                workspace = { hostRoot: input.workspace.hostRoot, targetRoot: materialized.targetRoot };
                if (materialized.baseline) input.projectFiles.onWorkspaceSeed?.(materialized.baseline);
            }
        } else if (input.projectFiles.projectFilesSourceWorkspace) {
            const sourceWorkspace = input.projectFiles.projectFilesSourceWorkspace;
            const targetRootPath = targetPathForRoot(JSON.stringify([sourceWorkspace.serverId, sourceWorkspace.machineId, sourceWorkspace.rootPath]));
            workspace = { hostRoot: sourceWorkspace.rootPath, targetRoot: targetRootPath };
            // The SOURCE owner carries admitted original-Machine bytes; the
            // controller must never interpret that root as its own local path.
            // Sync's existing relationship bootstrap also seeds its source,
            // while finite Copy once uses the same SOURCE transport directly.
            if (input.projectFiles.selection?.kind !== 'sync') {
                if (!input.projectFiles.prepareSource) throw refusal('workspace_source_operation_unavailable', 'The selected Project files source transport is unavailable');
                const materialized = await input.projectFiles.prepareSource({ sourceWorkspace, targetRootPath, signal,
                    ...(input.projectFiles.selection?.contentPolicy ? { contentPolicy: input.projectFiles.selection.contentPolicy } : {}) });
                workspace = { hostRoot: sourceWorkspace.rootPath, targetRoot: materialized.targetRootPath };
                input.projectFiles.onWorkspaceSeed?.(materialized.baseline, materialized.targetWorkspace, materialized.contentPolicyDigest);
            }
        } else {
            if (input.projectFiles.projectFilesSource) throw refusal('workspace_source_operation_unavailable', 'The selected Project files source is unavailable');
            const sourcePath = await realpath(input.workspace.hostRoot);
            const { materializeManagedWorkspaceSyncSeed } = await import('@/workspaces/sync/materializeManagedWorkspaceSyncSeed');
            const materialized = await materializeManagedWorkspaceSyncSeed({ target: input.target,
                sourcePath, targetPath: targetPathForRoot, activeServerDir: input.projectFiles.activeServerDir,
                registry: input.projectFiles.registry, signal, onProgress: input.projectFiles.onProgress,
                ...(input.projectFiles.selection?.contentPolicy ? { contentPolicy: input.projectFiles.selection.contentPolicy } : {}) });
            workspace = materialized.workspace;
            if (materialized.baseline) input.projectFiles.onWorkspaceSeed?.(materialized.baseline);
        }
        if (input.projectFiles.selection?.kind === 'sync') {
            const materialized = await input.projectFiles.prepareSync!({ sourceRootPath: workspace.hostRoot, targetRootPath: workspace.targetRoot,
                mode: input.projectFiles.selection.mode, signal,
                ...(input.projectFiles.selection.contentPolicy ? { contentPolicy: input.projectFiles.selection.contentPolicy } : {}) });
            if (materialized.targetWorkspace) {
                workspace = { hostRoot: workspace.hostRoot, targetRoot: materialized.targetWorkspace.rootPath };
                input.projectFiles.onWorkspaceSeed?.(undefined, materialized.targetWorkspace, materialized.contentPolicyDigest);
            }
        }
    }
    assertSessionTargetWorkspaceUnambiguous(workspace);
    const q = safeBashSingleQuote;
    const sessions = posix.join(input.target.home, '.happier', 'sessions');
    const base = posix.join(sessions, input.sessionKey);
    const run = async (command: string) => {
        const result = await input.target.exec(command, signal);
        if (result.status !== 0) throw refusal('provider_unavailable', 'A Session target launch command failed in the guest');
        return result.stdout;
    };
    activeSessionTargetKeys.add(input.sessionKey);
    // The Session's end (or its runner's crash) removes the directory unless an Agent of the Session still holds
    // it: a crashed runner's spared Agent keeps its credentials for the respawned runner that adopts it.
    input.onSessionEnd(async () => {
        try { await input.target.exec(`if ${q(input.target.helperPath)} file-lock -n -x ${q(`${base}/.live`)} -- true 2>/dev/null; then rm -rf ${q(base)}; fi`, signal); }
        finally { activeSessionTargetKeys.delete(input.sessionKey); }
    });
    await run(sweepEndedSessionsCommand(sessions, input.target.helperPath));
    await run(`umask 077; mkdir -p ${q(`${base}/agent-home`)}`);

    const env: Record<string, string> = {};
    if (input.materializedRoot) {
        const root = input.materializedRoot;
        const declared = credentialEntries ?? [];
        const files = (await listFiles(root)).filter(file => {
            const path = file.split(sep).join('/');
            return declared.some(entry => path === entry || path.startsWith(`${entry}/`));
        });
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

    // Materialized home selectors already have guest paths, not the runner's host paths.
    const providerEnvironmentKeys = input.providerEnvironmentKeys?.filter(key => !Object.hasOwn(env, key));
    Object.assign(env, input.target.agentEnvironment);
    // Provider selection replaces target defaults, including explicit unsets.
    // Names alone enter placement metadata; each launch supplies its admitted values.
    for (const key of providerEnvironmentKeys ?? []) delete env[key];
    const installEnvironment: NodeJS.ProcessEnv = { ...env };
    for (const key of providerEnvironmentKeys ?? []) installEnvironment[key] = input.runnerEnvironment[key];

    const executables: Record<string, string> = {};
    if (input.agentCommand) {
        const { platform } = input.target;
        const executable = await readExecutablePlatform(input.agentCommand).catch(() => null);
        const release = executable && executable !== 'script' && executable.os === platform.os && executable.arch === platform.arch
            ? { root: dirname(input.agentCommand), files: [basename(input.agentCommand)], command: basename(input.agentCommand) }
            : await stageAgentCliReleaseForTarget({ platform, runtime, install: input.agentCliInstall, signal });
        executables[input.agentCommand] = release
            ? await placeAgentCliRelease({ target: input.target, sessionKey: input.sessionKey, release, run, signal })
            : await installAgentCliInTarget({ target: input.target, runtime, env: installEnvironment,
                environmentPath: posix.join(base, 'install.environment'), signal });
    }
    return { executables, env, ...(providerEnvironmentKeys?.length ? { providerEnvironmentKeys } : {}),
        workspace, runtimeHome: base, lockPath: posix.join(base, '.live'), lockExecutable: input.target.helperPath };
}

type AgentCliRelease = Readonly<{ root: string; files: ReadonlyArray<string>; command: string }>;

/**
 * The Agent's GitHub release for a target of another OS or architecture, staged
 * on this Machine by the install owner. `null` when the Agent has no such
 * release (its CLI installs through a vendor recipe in the target instead).
 */
async function stageAgentCliReleaseForTarget(input: Readonly<{
    platform: ManagedSessionTarget['platform'];
    runtime: AgentCliRuntimeDescriptor | null;
    install: Parameters<typeof deliverSessionTargetLaunch>[0]['agentCliInstall'];
    signal: AbortSignal;
}>): Promise<AgentCliRelease | null> {
    const { platform } = input;
    if (!input.runtime) return null;
    const staged = await installAgentCliForTarget({ runtimeSpec: input.runtime, target: { platform: platform.os, arch: platform.arch },
        env: input.install?.env ?? process.env, ...(input.install?.deps ? { deps: input.install.deps } : {}), signal: input.signal });
    if (!staged.ok && staged.errorCode === 'no-recipe') return null;
    const unavailable = (detail: string) => refusal('agent_cli_target_unavailable', `This Agent CLI cannot run in a ${platform.os}-${platform.arch} target: ${detail}`);
    if (!staged.ok) throw unavailable(`its ${platform.arch} release could not be staged on this Machine (${staged.errorCode})`);
    // The asset declaration is the catalog's: a release that is not an executable for the target is never placed.
    const executable = await readExecutablePlatform(staged.command).catch(() => null);
    if (!executable || executable === 'script' || executable.os !== platform.os || executable.arch !== platform.arch) {
        throw unavailable(`its release is not a ${platform.os}-${platform.arch} executable`);
    }
    return { root: staged.installDir, files: staged.files, command: relative(staged.installDir, staged.command).split(sep).join('/') };
}

/**
 * Places an Agent CLI's files (the executable, plus the declared files of a
 * managed release) once per content digest in the target
 * (`~/.happier/agent-cli/<sha256 of the sha256sum list>/`): streamed through
 * the provider channel into a staging directory, verified there against the
 * digests computed here, then moved into place. Returns the placed executable.
 */
async function placeAgentCliRelease(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'home' | 'exec' | 'openChannel'>;
    sessionKey: string;
    release: AgentCliRelease;
    run(command: string): Promise<string>;
    signal: AbortSignal;
}>): Promise<string> {
    const q = safeBashSingleQuote;
    const { release } = input;
    const sums = await Promise.all(release.files.map(async file => `${await hashFile(join(release.root, ...file.split('/')))}  ${file}\n`));
    const list = sums.join('');
    const directory = posix.join(input.target.home, '.happier', 'agent-cli', createHash('sha256').update(list).digest('hex'));
    const verifies = (dir: string) => `(${REMOTE_SHA256_FILE_FUNCTION}; cd ${q(dir)} 2>/dev/null && printf '%s' ${q(list)} | sha256_files -c >/dev/null 2>&1)`;
    const placed = posix.join(directory, release.command);
    if ((await input.target.exec(`${verifies(directory)} && echo present`, input.signal)).stdout.trim() === 'present') return placed;
    const staged = `${directory}.${input.sessionKey}.staged`;
    const paths = release.files.map(file => posix.join(staged, file));
    await input.run(`umask 077; rm -rf ${q(staged)} && mkdir -p ${[...new Set(paths.map(path => posix.dirname(path)))].map(q).join(' ')}`);
    for (const [index, file] of release.files.entries()) {
        // Too large for one provider file put: stream it through the channel, then verify in the guest.
        await writeManagedChannelFile({ path: paths[index]!, bytes: createReadStream(join(release.root, ...file.split('/'))),
            signal: input.signal, openChannel: argv => input.target.openChannel(argv, input.signal) });
    }
    // A directory at the digest that does not verify is replaced; a concurrent Session's completed copy is kept.
    const promoted = await input.run(`if ${verifies(staged)}; then chmod 700 ${paths.map(q).join(' ')} && `
        + `if ${verifies(directory)}; then rm -rf ${q(staged)}; else rm -rf ${q(directory)} && mv -f ${q(staged)} ${q(directory)}; fi; `
        + `if ${verifies(directory)}; then echo promoted; fi; else rm -rf ${q(staged)}; echo mismatch; fi`);
    if (promoted.trim() !== 'promoted') throw refusal('agent_cli_target_unavailable', 'The Agent CLI did not verify in the Session target');
    return placed;
}

/** The leased runtime registry members the launch step reads (catalog facts live under `contributes`). */
export type SessionTargetAgentCatalog = Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'acquireAgentCatalogEntry'>;

async function readSessionTargetAgent(agent: Readonly<{ id: string; catalog: SessionTargetAgentCatalog }> | null) {
    if (!agent) return { credentialEntries: null, runtime: null };
    const entry = agent.catalog.acquireAgentCatalogEntry
        ? await agent.catalog.acquireAgentCatalogEntry(agent.id)
        : agent.catalog.contributes.catalogEntriesById[agent.id];
    const sharing = await entry?.getConnectedServiceStateSharingDescriptor?.();
    return { credentialEntries: sharing?.authIsolation?.secretEntries ?? null,
        runtime: agent.catalog.contributes.agentDefinitionsById.get(agent.id)?.runtimeSpec ?? null };
}


/**
 * The provider's install recipe run in the target (the guest user's own
 * install, like an Agent install on a member Machine): reused when the CLI is
 * already in one of the provider's declared user bin directories. Only
 * no-admin vendor recipes run there; a managed package needs this Machine's
 * runtime and is not placeable.
 */
async function installAgentCliInTarget(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'home' | 'platform' | 'exec' | 'openChannel'>;
    runtime: AgentCliRuntimeDescriptor | null;
    env: Readonly<NodeJS.ProcessEnv>;
    environmentPath: string;
    signal: AbortSignal;
}>): Promise<string> {
    const { platform } = input.target;
    const unavailable = (detail: string) => refusal('agent_cli_target_unavailable', `This Agent CLI cannot run in a ${platform.os}-${platform.arch} target: ${detail}`);
    const planned = input.runtime ? planAgentCliInstallForRuntime({ runtimeSpec: input.runtime, platform: platform.os }) : null;
    if (!input.runtime || !planned?.ok || planned.plan.installMode !== 'vendor_recipe' || planned.plan.requiresAdmin) {
        throw unavailable('this Machine\'s CLI cannot run in it and the Agent has no install recipe a target user can run');
    }
    const q = safeBashSingleQuote;
    const binDirectories = (input.runtime.knownUserBinDirSuffixes ?? []).map(suffix => posix.join(input.target.home, suffix));
    const prelude = [`export HOME=${q(input.target.home)}`,
        ...(binDirectories.length ? [`export PATH=${q(binDirectories.join(':'))}:"$PATH"`] : []), 'cd "$HOME"'].join('; ');
    const run = (command: string) => execWithManagedChannelEnvironment({ path: input.environmentPath,
        environment: input.env, command: `${prelude}; ${command}`, signal: input.signal,
        exec: command => input.target.exec(command, input.signal),
        openChannel: argv => input.target.openChannel(argv, input.signal) });
    const locate = async () => (await run(`command -v ${q(input.runtime!.binaryName)} || true`)).stdout.trim();
    const present = await locate();
    if (present.startsWith('/')) return present;
    for (const step of planned.plan.commands) {
        const runnable = (await run(`command -v ${q(step.cmd)} >/dev/null 2>&1 && echo yes`)).stdout.trim();
        if (runnable !== 'yes') throw unavailable(`its install recipe needs \`${step.cmd}\` in the target`);
        const result = await run([step.cmd, ...step.args].map(q).join(' '));
        if (result.status !== 0) {
            throw unavailable(result.status === 127 ? 'its install recipe needs a command the target does not have' : 'its install recipe failed in the target');
        }
    }
    const installed = await locate();
    if (!installed.startsWith('/')) throw unavailable('its install recipe did not install the CLI where the Agent declares it');
    return installed;
}
