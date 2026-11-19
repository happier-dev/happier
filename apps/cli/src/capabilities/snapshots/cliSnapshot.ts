import { AGENTS } from '@/agent/catalog/registry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { observeCurrentAgentSessionFactory, readCurrentCatalogHook, type AgentSessionFactorySource } from '@/agent/catalog/runtimeEntry';
import type { AgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import type { CliDetectSpec } from '@/agent/catalog/types';
import type { CliAuthStatus } from '@/capabilities/cliAuth/types';
import { CapabilityError } from '@/capabilities/errors';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { readHeldNativeAgentCliAuthStatus } from '@/capabilities/cliAuth/heldNativeAgentCliAuthStatus';
import { resolveCliSnapshotProbeTimeoutMs } from './cliSnapshotProbeTimeout';
import { CliVersionCache, type CliVersionProbeResult } from './cliVersionCache';
import {
    resolveAgentCliCommandForRuntime,
    resolveAgentCliJavaScriptRuntimeOnDaemonPath as resolveJavaScriptRuntimeExecutableForCliSnapshot,
} from '@/packagedRuntime/managedTools/agentCliResolution';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol';
import { resolveAgentSetupInstall, resolveAgentSetupPlatform } from '@happier-dev/protocol/agents/setup';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import {
    resolveAgentRuntimeManagedDependencyId,
    resolveExecutableManagedDependenciesRegistry,
    selectExecutableManagedDependencies,
} from '@/plugins/projection/registry/managedDependencyExecutables';
import {
    type AgentCliRuntimeDescriptor,
    type AgentCliCommandResolutionOptions,
    type AgentCliSourcePolicy,
    agentCliPathRequiresJavaScriptRuntime,
    resolveAgentCliJavaScriptRuntimeCommand,
    classifyAgentCliInstall,
    resolvePlatformFromNodePlatform,
} from '@happier-dev/cli-common/agents';
import { buildMemberAgentCliResolutionEnvironment } from '@/capabilities/installJobs/memberResolveEffect';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { hashStableJsonIdentity } from '@/utils/stableJsonIdentity';
import {
    execFileWithDeadline,
    ExecFileTerminationError,
    resolveWindowsCommandInvocation,
    resolveExecutableCommand,
    type ExecFileWithDeadlineOptions,
} from '@happier-dev/cli-common/process';

/**
 * Version probing reads the CLI's OUTPUT, so the budget must not be `child_process`'s own
 * `timeout`: on a stalled loop that destroys a finished child's banner and still reports success,
 * leaving a genuinely installed CLI with `version: null`.
 */
type ExecFileBestEffortOptions = ExecFileWithDeadlineOptions;

export type DetectCliName = string;

export interface DetectCliRequest {
    /** Host-selected native source policy, independent of Account preferences. */
    resolution?: Pick<AgentCliCommandResolutionOptions, 'sourcePolicy' | 'memberSharedManagedToolsRoot'>;
    /**
     * When true, also probes whether each detected CLI appears to be authenticated.
     * This is best-effort and may return null when unknown/unsupported.
     */
    includeLoginStatus?: boolean;
    /** Optional version metadata defaults on; strict verification always probes it. */
    includeVersion?: boolean;
    bypassCache?: boolean;
    /**
     * Probe versions with the slow-probe budget instead of the ambient one. Used to
     * verify an update, where a slow `--version` must not read as "no version".
     */
    verifyVersion?: boolean;
    requestedCliNames?: readonly DetectCliName[];
    /** Host-selected tool probes; omitted by callers requesting the full snapshot. */
    requestedTools?: readonly ('tmux' | 'windowsTerminal')[];
}

export interface DetectCliEntry {
    available: boolean;
    /** Internal observation failure; capability projection emits the existing typed error result. */
    detectionError?: { code: 'cli-detection-timeout' | 'cli-detection-failed'; message: string };
    /** Admitted native runtime or own CLI execution, never inferred from an installed dependency. */
    installed?: boolean;
    signIn?: MachineAgentInventoryItem['signIn'];
    platform?: MachineAgentInventoryItem['platform'];
    install?: MachineAgentInventoryItem['install'];
    dependencies?: MachineAgentInventoryItem['dependencies'];
    update?: MachineAgentInventoryItem['update'];
    resolvedPath?: string;
    resolvedCommand?: string;
    resolutionSource?: 'override' | 'system' | 'managed';
    resolutionReadOnly?: true;
    version?: string;
    isLoggedIn?: boolean | null;
    authStatus?: CliAuthStatus | null;
    /**
     * Optional ACP agent capability probe results for CLIs that can run in ACP mode.
     * This is only populated when a capabilities request explicitly asks for it.
     */
    acp?: {
        ok: boolean;
        checkedAt: number;
        loadSession?: boolean | null;
        agentCapabilities?: {
            loadSession: boolean;
            sessionCapabilities: Record<string, unknown>;
            promptCapabilities: {
                image: boolean;
                audio: boolean;
                embeddedContext: boolean;
            };
            mcpCapabilities: {
                http: boolean;
                sse: boolean;
            };
        } | null;
        error?: { message: string };
    };
}

export interface DetectTmuxEntry {
    available: boolean;
    resolvedPath?: string;
    version?: string;
}

export interface DetectWindowsTerminalEntry {
    available: boolean;
    resolvedPath?: string;
}

export interface DetectCliSnapshot {
    path: string | null;
    clis: Record<DetectCliName, DetectCliEntry>;
    tmux: DetectTmuxEntry;
    windowsTerminal: DetectWindowsTerminalEntry;
}

// Detection follows its inputs, not UI demand. Each Agent's facts are re-derived per request
// from the filesystem (resolution, install class, launch command); the process-backed facts are
// held by their owners until their inputs change: versions per executable identity
// (cliVersionCache) and the signed-in fact per binary/config/auth env (heldNativeAgentCliAuthStatus).
// Facts are per Agent, so one Agent's failure never affects another or another request shape.
const cliVersionCache = new CliVersionCache();

const CLI_SNAPSHOT_PROBE_TIMEOUT = Symbol('CLI_SNAPSHOT_PROBE_TIMEOUT');

async function withCliSnapshotProbeTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof CLI_SNAPSHOT_PROBE_TIMEOUT> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<typeof CLI_SNAPSHOT_PROBE_TIMEOUT>((resolve) => {
                timeoutId = setTimeout(() => resolve(CLI_SNAPSHOT_PROBE_TIMEOUT), timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}

function buildCliSnapshotEnvironmentKey(params: DetectCliRequest, environment: NodeJS.ProcessEnv, cwd: string): string {
    // Resolution, native runtimes and auth consume the same admitted environment.
    // Hash it through the existing identity owner instead of copying their selectors.
    return JSON.stringify([params.resolution ?? {}, hashStableJsonIdentity(environment), cwd]);
}

function getFirstLine(value: string): string | null {
    const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
    if (!normalized) return null;
    const [first] = normalized.split('\n');
    const trimmed = first.trim();
    if (!trimmed) return null;
    return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function extractSemver(value: string | null): string | null {
    if (!value) return null;
    const match = value.match(/\b[vV]?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    return match?.[1] ?? null;
}

function extractTmuxVersion(value: string | null): string | null {
    if (!value) return null;
    const match = value.match(/\btmux\s+([0-9]+(?:\.[0-9]+)?[a-z]?)\b/i);
    return match?.[1] ?? null;
}

function quoteShellArgument(value: string): string {
    if (process.platform === 'win32') {
        return `"${value.replaceAll('"', '""')}"`;
    }
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function resolveCliLaunchCommand(params: { resolvedPath: string; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<string> {
    if (!agentCliPathRequiresJavaScriptRuntime(params.resolvedPath)) {
        return quoteShellArgument(params.resolvedPath);
    }

    const runtimeExecutable = params.env
        ? resolveAgentCliJavaScriptRuntimeCommand(params.resolvedPath, params.env,
            { isBunRuntime: typeof process.versions.bun === 'string', currentExecPath: process.execPath, cwd: params.cwd })
        : await resolveJavaScriptRuntimeExecutableForCliSnapshot(params.resolvedPath);
    if (!runtimeExecutable) return quoteShellArgument(params.resolvedPath);
    return `${quoteShellArgument(runtimeExecutable)} ${quoteShellArgument(params.resolvedPath)}`;
}

function defaultVersionArgsToTry(): Array<string[]> {
    return [['--version'], ['version'], ['-v']];
}

const cliDetectCache = new Map<DetectCliName, CliDetectSpec | null>();

async function resolveCliDetectSpec(name: DetectCliName): Promise<CliDetectSpec | null> {
    if (cliDetectCache.has(name)) {
        return cliDetectCache.get(name) ?? null;
    }

    const entry = AGENTS[name];
    if (!entry?.getCliDetect) {
        cliDetectCache.set(name, null);
        return null;
    }

    const spec = await entry.getCliDetect();
    cliDetectCache.set(name, spec);
    return spec;
}

async function resolveCliVersionArgsToTry(name: DetectCliName): Promise<Array<string[]>> {
    const spec = (await resolveCliDetectSpec(name))?.versionArgsToTry;
    if (!spec || spec.length === 0) return defaultVersionArgsToTry();
    return spec.map((v) => [...v]);
}

export type RunResolvedAgentCliVersionCommand = (input: Readonly<{
    agentId: string;
    launch: AgentCliLaunchSpec;
    args: readonly string[];
    timeoutMs: number;
    signal?: AbortSignal;
}>) => Promise<Readonly<{ stdout: string; stderr: string }>>;

async function probeCliExecution(params: { name: DetectCliName; resolvedPath: string; timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; execFile?: typeof execFileWithDeadline; launch?: AgentCliLaunchSpec; runVersionCommand?: RunResolvedAgentCliVersionCommand }): Promise<CliVersionProbeResult & Readonly<{ installed?: boolean; detectionError?: DetectCliEntry['detectionError'] }>> {
    let installed = false;
    let interrupted = false;
    let detectedVersion: CliVersionProbeResult = { version: null, successful: false };
    const result = (observation: CliVersionProbeResult) => !installed && interrupted
        ? { ...observation, detectionError: { code: 'cli-detection-timeout' as const, message: 'Agent CLI detection did not complete' } }
        : { installed, ...observation };
    // Ordinary probe failures are best-effort; cancellation and failed containment must escape.
    try {
        // Keep this within the outer snapshot probe budget. JS-backed CLIs can take
        // noticeably longer to start under load, so this must not use a smaller
        // hidden timeout than the configured snapshot budget.
        const timeoutMs = params.timeoutMs;
        const isWindows = process.platform === 'win32';
        const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);
        const needsJavaScriptRuntime = agentCliPathRequiresJavaScriptRuntime(params.resolvedPath);

        const asString = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (Buffer.isBuffer(value)) return value.toString('utf8');
            return '';
        };

        const argsToTry: Array<string[]> = await (async () => {
            try {
                return await resolveCliVersionArgsToTry(params.name);
            } catch {
                return defaultVersionArgsToTry();
            }
        })();

        const isTransientExecFileError = (error: unknown): boolean => {
            if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
            const code = Reflect.get(error, 'code');
            if (typeof code === 'string' && ['EAGAIN', 'EMFILE', 'ENFILE', 'ETXTBSY'].includes(code)) return true;
            if (Reflect.get(error, 'killed') === true) return true;
            return false;
        };

        const execFileBestEffort = async (
            file: string,
            args: string[],
            options: ExecFileBestEffortOptions,
        ): Promise<{ stdout: string; stderr: string; error: unknown | null }> => {
            try {
                const { stdout, stderr } = params.launch && params.runVersionCommand
                    ? await params.runVersionCommand({
                        agentId: params.name,
                        launch: params.launch,
                        args: args.slice(params.launch.args.length),
                        timeoutMs,
                        signal: params.signal,
                    })
                    : await (params.execFile ?? execFileWithDeadline)(file, args, {
                        ...options,
                        terminateOnAbort: terminateProcessTree,
                    });
                installed = true;
                return { stdout: asString(stdout), stderr: asString(stderr), error: null };
            } catch (error) {
                if (params.runVersionCommand) throw error;
                if (error instanceof ExecFileTerminationError) throw error;
                params.signal?.throwIfAborted();
                if (isTransientExecFileError(error)) interrupted = true;
                // For non-zero exit codes, execFile still provides stdout/stderr on the error object.
                const maybeStdout = asString((error as any)?.stdout);
                const maybeStderr = asString((error as any)?.stderr);
                return { stdout: maybeStdout, stderr: maybeStderr, error };
            }
        };

	        const probeSemverOnce = async (
	            file: string,
	            args: string[],
	            options: ExecFileBestEffortOptions,
	        ): Promise<{ semver: string | null; error: unknown | null; combinedTrimmed: string }> => {
	            const { stdout, stderr, error } = await execFileBestEffort(file, args, options);
	            const combined = `${stdout}\n${stderr}`;
	            const combinedTrimmed = combined.trim();
	            const firstLine = getFirstLine(combined);
	            const semver = extractSemver(firstLine) ?? extractSemver(combined);
	            return { semver, error, combinedTrimmed };
	        };

        const probeSemverWithRetry = async (
            file: string,
            args: string[],
            options: ExecFileBestEffortOptions,
	        ): Promise<CliVersionProbeResult> => {
	            const first = await probeSemverOnce(file, args, options);
	            if (first.semver) return { version: first.semver, successful: first.error === null };

	            const shouldRetry =
	                (first.error && isTransientExecFileError(first.error))
	                || (!first.error && first.combinedTrimmed.length === 0);
	            if (!shouldRetry) return { version: null, successful: false };

	            // Best-effort retry for transient spawn/timeout failures (can happen under load).
	            await new Promise((resolve) => setTimeout(resolve, 0));
	            const second = await probeSemverOnce(file, args, options);
	            return { version: second.semver, successful: second.error === null };
        };

        if (params.launch && params.runVersionCommand) {
            for (const args of argsToTry) {
                const observation = await probeSemverWithRetry(params.launch.command, [...params.launch.args, ...args], {
                    timeout: timeoutMs,
                    windowsHide: true,
                    signal: params.signal,
                });
                detectedVersion = observation.version ? observation : detectedVersion;
                if (observation.version && installed) return result(observation);
            }
            return result(detectedVersion);
        }

        if (needsJavaScriptRuntime) {
            const runtimeExecutable = params.env
                ? resolveAgentCliJavaScriptRuntimeCommand(params.resolvedPath, params.env, { isBunRuntime: typeof process.versions.bun === 'string', currentExecPath: process.execPath, cwd: params.cwd })
                : await resolveJavaScriptRuntimeExecutableForCliSnapshot(params.resolvedPath);
            if (!runtimeExecutable) return result({ version: null, successful: false });
            for (const args of argsToTry) {
                const observation = await probeSemverWithRetry(runtimeExecutable, [params.resolvedPath, ...args], {
                    timeout: timeoutMs,
                    windowsHide: true,
                    env: params.env,
                    cwd: params.cwd,
                    signal: params.signal,
                });
                detectedVersion = observation.version ? observation : detectedVersion;
                if (observation.version && installed) return result(observation);
            }
            return result(detectedVersion);
        }

        if (isCmdScript) {
            // .cmd/.bat require cmd.exe.
            for (const args of argsToTry) {
                const invocation = resolveWindowsCommandInvocation({
                    command: params.resolvedPath,
                    args,
                    resolveCommandOnPath: false,
                });
                const observation = await probeSemverWithRetry(invocation.command, invocation.args, {
                    timeout: timeoutMs,
                    windowsHide: true,
                    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                    env: params.env,
                    cwd: params.cwd,
                    signal: params.signal,
                });
                detectedVersion = observation.version ? observation : detectedVersion;
                if (observation.version && installed) return result(observation);
            }
            return result(detectedVersion);
        }

        for (const args of argsToTry) {
            const observation = await probeSemverWithRetry(params.resolvedPath, args, {
                timeout: timeoutMs,
                windowsHide: true,
                env: params.env,
                cwd: params.cwd,
                signal: params.signal,
            });
            detectedVersion = observation.version ? observation : detectedVersion;
            if (observation.version && installed) return result(observation);
        }

        return result(detectedVersion);
    } catch (error) {
        if (params.runVersionCommand) throw error;
        if (error instanceof ExecFileTerminationError) throw error;
        params.signal?.throwIfAborted();
        return result({ version: null, successful: false });
    }
}

/** Reads version facts for an already-resolved Agent CLI without resolving another executable. */
export async function probeResolvedAgentCliVersion(params: Readonly<{
    agentId: string;
    launch: AgentCliLaunchSpec;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    runVersionCommand: RunResolvedAgentCliVersionCommand;
}>): Promise<string | null> {
    params.signal?.throwIfAborted();
    const probe = await probeCliExecution({
        name: params.agentId,
        resolvedPath: params.launch.resolvedPath,
        launch: params.launch,
        runVersionCommand: params.runVersionCommand,
        timeoutMs: resolveCliSnapshotProbeTimeoutMs(true, params.env),
        env: params.env,
        signal: params.signal,
    });
    params.signal?.throwIfAborted();
    if (probe.detectionError) {
        throw new CapabilityError(probe.detectionError.message, probe.detectionError.code);
    }
    return probe.version;
}

/** Fresh install verification uses the same resolver and version probe as inventory. */
export async function probeAgentCliForInstall(params: Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    sourcePolicy?: AgentCliSourcePolicy;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    execFile?: typeof execFileWithDeadline;
}>): Promise<DetectCliEntry> {
    params.signal?.throwIfAborted();
    const environment = params.sourcePolicy === 'member'
        ? buildMemberAgentCliResolutionEnvironment(params.env ?? process.env) : params.env ?? process.env;
    const resolution = resolveAgentCliCommandForRuntime(params.runtimeSpec, { processEnv: environment,
        sourcePolicy: params.sourcePolicy });
    if (!resolution) return { available: false, installed: false };
    const probe = await probeCliExecution({
        name: params.runtimeSpec.id,
        resolvedPath: resolution.command,
        timeoutMs: resolveCliSnapshotProbeTimeoutMs(true, environment),
        env: environment,
        signal: params.signal,
        execFile: params.execFile,
    });
    if (probe.detectionError) {
        throw new CapabilityError(probe.detectionError.message, probe.detectionError.code);
    }
    return {
        available: probe.installed === true,
        ...(probe.installed !== undefined ? { installed: probe.installed } : {}),
        resolvedPath: resolution.command,
        resolutionSource: resolution.source,
        ...(probe.version ? { version: probe.version } : {}),
    };
}

async function detectTmuxVersion(params: { resolvedPath: string; env: NodeJS.ProcessEnv; cwd: string }): Promise<string | null> {
    // Best-effort, must never throw.
    try {
        const timeoutMs = 1500;
        const isWindows = process.platform === 'win32';
        const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);

        const asString = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (Buffer.isBuffer(value)) return value.toString('utf8');
            return '';
        };

        const execFileBestEffort = async (file: string, args: string[], options: ExecFileBestEffortOptions): Promise<{ stdout: string; stderr: string }> => {
            try {
                const { stdout, stderr } = await execFileWithDeadline(file, args, options);
                return { stdout: asString(stdout), stderr: asString(stderr) };
            } catch (error) {
                const maybeStdout = asString((error as any)?.stdout);
                const maybeStderr = asString((error as any)?.stderr);
                return { stdout: maybeStdout, stderr: maybeStderr };
            }
        };

        if (isCmdScript) {
            const invocation = resolveWindowsCommandInvocation({
                command: params.resolvedPath,
                args: ['-V'],
                resolveCommandOnPath: false,
            });
            const { stdout, stderr } = await execFileBestEffort(invocation.command, invocation.args, {
                timeout: timeoutMs,
                windowsHide: true,
                windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                env: params.env,
                cwd: params.cwd,
            });
            return extractTmuxVersion(getFirstLine(`${stdout}\n${stderr}`));
        }

        const { stdout, stderr } = await execFileBestEffort(params.resolvedPath, ['-V'], {
            timeout: timeoutMs,
            windowsHide: true,
            env: params.env,
            cwd: params.cwd,
        });
        return extractTmuxVersion(getFirstLine(`${stdout}\n${stderr}`));
    } catch {
        return null;
    }
}

/** Sign-in for detection is the same held fact the spawn path reads (P03 S4), never a second probe path. */
async function detectCliAuthStatus(params: { name: DetectCliName; resolvedPath: string; timeoutMs: number; env: NodeJS.ProcessEnv; cwd: string; fresh: boolean }): Promise<CliAuthStatus | null> {
    const agent = readCurrentContributionRegistry().agentDefinitionsById.get(params.name);
    const declared = await readCurrentCatalogHook(params.name, async (entry) => ({
        nativeHome: (await entry.getConnectedServiceStateSharingDescriptor?.())?.nativeHome,
        authSpec: await entry.getCliAuthSpec?.() ?? null,
    })).catch(() => null);
    return await readHeldNativeAgentCliAuthStatus({
        agentId: params.name,
        resolvedPath: params.resolvedPath,
        timeoutMs: params.timeoutMs,
        processEnv: params.env,
        cwd: params.cwd,
        ...(declared?.nativeHome ? { nativeHome: declared.nativeHome } : {}),
        ...(declared ? { authSpec: declared.authSpec } : {}),
        authEnvironmentVariables: agent?.cliMetadata?.auth.environmentVariables ?? [],
        fresh: params.fresh,
    });
}

async function resolveCliPathForName(
    name: DetectCliName,
    options?: AgentCliCommandResolutionOptions,
): Promise<Readonly<{ resolvedPath: string; resolutionSource: 'override' | 'system' | 'managed'; readOnly?: true }> | null> {
    const runtimeSpec = readCurrentContributionRegistry().agentDefinitionsById.get(name)?.runtimeSpec;
    if (!runtimeSpec) return null;
    const resolved = resolveAgentCliCommandForRuntime(runtimeSpec, options);
    return resolved ? { resolvedPath: resolved.command, resolutionSource: resolved.source,
        ...(resolved.readOnly ? { readOnly: resolved.readOnly } : {}),
    } : null;
}

export async function detectAgentSetupFacts(name: DetectCliName, includeVersion: boolean, memberNotPrepared = false, environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): Promise<Pick<MachineAgentInventoryItem, 'platform' | 'install' | 'dependencies' | 'signIn'>> {
    const registry = readCurrentContributionRegistry();
    const agent = registry.agentDefinitionsById.get(name);
    const dependencyId = agent ? resolveAgentRuntimeManagedDependencyId(agent) : null;
    const declarations = (registry.managedDependencies ?? []).filter((entry) => (
        entry.pluginId && buildQualifiedPluginContributionKey({ pluginId: entry.pluginId, localId: entry.definition.id }) === dependencyId
    ));
    const metadata = {
        cli: agent?.cliMetadata,
        dependencies: declarations.flatMap((entry) => 'version' in entry.definition ? [] : [entry.definition]),
        platform: process.platform,
        arch: process.arch,
    };
    const dependencies: MachineAgentInventoryItem['dependencies'] = [];
    if (dependencyId && !memberNotPrepared) {
        const installablesRegistry = resolveExecutableManagedDependenciesRegistry(declarations);
        const candidates = await Promise.all(selectExecutableManagedDependencies(declarations).map(async ({ definition }) => {
            const adapter = await getRuntimeInstallableAdapter(definition.key, { installablesRegistry });
            const launch = await adapter.detectLaunchResolution({ env: environment });
            const status = includeVersion && launch.availability.ok && adapter.detectCapabilityStatus
                ? await adapter.detectCapabilityStatus({ env: environment, onlyIfInstalled: true })
                : null;
            const version = status && typeof status === 'object'
                ? Reflect.get(status, 'version') ?? Reflect.get(status, 'installedVersion')
                : null;
            return { key: definition.key, installed: launch.availability.ok, version: typeof version === 'string' ? version : null };
        }));
        // Sources are alternatives for one declared prerequisite, not separate required installs.
        dependencies.push(candidates.find((entry) => entry.installed) ?? candidates[0]
            ?? { key: dependencyId, installed: false, version: null });
    }
    return {
        platform: resolveAgentSetupPlatform(metadata),
        install: resolveAgentSetupInstall(metadata),
        dependencies,
        signIn: { status: 'unknown', loginSupport: agent?.cliMetadata?.auth.support ?? 'unsupported' },
    };
}

/**
 * Drops every cached snapshot. Called after something changed an installed CLI (an update),
 * so the next ordinary detect reports what is installed now rather than a pre-change snapshot.
 */
export function invalidateCliSnapshots(): void {
    cliVersionCache.clear();
}

/**
 * CLI status snapshot - checks whether CLIs are resolvable on daemon PATH.
 *
 * This is more reliable than the `bash` RPC for "is CLI installed?" checks because it:
 * - does not rely on a login shell (no ~/.zshrc, ~/.profile, etc)
 * - matches how the daemon itself will resolve binaries when spawning
 */
export async function detectCliSnapshotOnDaemonPath(data: DetectCliRequest, factorySource?: AgentSessionFactorySource, environment: NodeJS.ProcessEnv = sessionProcessEnvironment(), cwd: string = sessionWorkingDirectory()): Promise<DetectCliSnapshot> {
    const pathEnv = typeof environment.PATH === 'string' ? environment.PATH : null;
    const includeLoginStatus = Boolean(data?.includeLoginStatus);
    const verifyVersion = data?.verifyVersion === true;
    const includeVersion = data?.includeVersion !== false || verifyVersion;
    const requestedCliNames = Array.isArray(data?.requestedCliNames)
        ? data.requestedCliNames.filter((name): name is DetectCliName => typeof name === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, name))
        : [];
    const probeTimeoutMs = resolveCliSnapshotProbeTimeoutMs(includeLoginStatus || verifyVersion, environment);
    const names = requestedCliNames.length > 0 ? requestedCliNames : Object.keys(AGENTS) as DetectCliName[];
    const nativeFactoryObservations = await Promise.allSettled(names.map(name => observeCurrentAgentSessionFactory(name, factorySource)));
    const nativeFactories = new Map(names.map((name, index) => [name, nativeFactoryObservations[index]!] as const));
    const resolutionEnvironment = data.resolution?.sourcePolicy === 'member'
        ? buildMemberAgentCliResolutionEnvironment(environment, data.resolution.memberSharedManagedToolsRoot) : environment;
    // Explicit refresh and verification re-probe; ordinary reads reuse facts whose inputs are unchanged.
    const fresh = data.bypassCache === true || verifyVersion;
    const resolveCommand = (command: string) => resolveExecutableCommand(command, { env: resolutionEnvironment, cwd });

    try {
    const observations = await Promise.allSettled(
        names.map(async (name) => {
            const factoryObservation = nativeFactories.get(name)!;
            const factory = factoryObservation.status === 'fulfilled' ? factoryObservation.value : null;
            const [resolved, setupFacts] = await Promise.all([
                factory?.isCurrent() ? Promise.resolve(null) : resolveCliPathForName(name, {
                    ...data.resolution, processEnv: resolutionEnvironment, cwd,
                }),
                detectAgentSetupFacts(name, includeVersion, false, resolutionEnvironment),
            ]);
            if (!resolved) {
                // A successful physical CLI probe is independent of native runtime admission;
                // without either observation, absence is unknown rather than an uninstall.
                if (factoryObservation.status === 'rejected') throw factoryObservation.reason;
                if (factory?.isCurrent()) return [name, {
                    available: true, installed: true, ...setupFacts,
                    signIn: { ...setupFacts.signIn, required: factory.nativeAuthenticationRequired },
                    update: { supported: false, command: null },
                } satisfies DetectCliEntry] as const;
                const entry: DetectCliEntry = { available: false, installed: false, ...setupFacts, update: { supported: false, command: null } };
                return [name, entry] as const;
            }
            const { resolvedPath, resolutionSource, readOnly } = resolved;
            const runtimeSpec = resolveAgentCliRuntimeSpecForLookupId(name);
            const platform = resolvePlatformFromNodePlatform(process.platform);
            const update = platform
                ? classifyAgentCliInstall({ runtimeSpec, command: resolvedPath, source: resolutionSource,
                    ...(readOnly ? { readOnly } : {}), platform, env: resolutionEnvironment })
                : null;

            const [versionResult, authStatusResult, resolvedCommandResult] = await Promise.all([
                // The process boundary owns the deadline and drains finished output after a
                // stalled loop. A competing timer here would discard that successful result.
                includeVersion ? cliVersionCache.read({ name, resolvedPath, fresh, resolveCommand,
                    // The environment projection, scoped to this Agent: request shape (requested set,
                    // login status, tools, probe budget) never splits one executable's version fact.
                    probeKey: buildCliSnapshotEnvironmentKey({ requestedCliNames: [name],
                        resolution: data.resolution }, resolutionEnvironment, cwd),
                    probe: () => probeCliExecution({ name, resolvedPath, timeoutMs: probeTimeoutMs,
                        env: resolutionEnvironment, cwd,
                    }),
                }).then(version => ({ version })) : Promise.resolve({ version: null }),
                includeLoginStatus
                    ? withCliSnapshotProbeTimeout(
                        detectCliAuthStatus({ name, resolvedPath, timeoutMs: probeTimeoutMs, env: resolutionEnvironment, cwd, fresh }),
                        probeTimeoutMs,
                    )
                    : Promise.resolve(null),
                withCliSnapshotProbeTimeout(
                    resolveCliLaunchCommand({ resolvedPath, env: resolutionEnvironment, cwd }),
                    probeTimeoutMs,
                ),
            ]);

            const authStatus = (() => {
                if (!includeLoginStatus) return null;
                if (authStatusResult === CLI_SNAPSHOT_PROBE_TIMEOUT) {
                    return {
                        checkedAt: Date.now(),
                        state: 'unknown',
                        reason: 'timeout',
                        source: 'command',
                    } satisfies CliAuthStatus;
                }
                return authStatusResult;
            })();

            const isLoggedIn = includeLoginStatus
                ? (authStatus?.state === 'logged_in'
                    ? true
                    : authStatus?.state === 'logged_out'
                        ? false
                        : null)
                : null;


            const entry: DetectCliEntry = {
                available: true,
                // The launch resolver already established a runnable installation.
                // Optional version metadata cannot revoke that executable fact.
                installed: true,
                ...setupFacts,
                signIn: {
                    status: authStatus?.state === 'logged_in' ? 'signedIn' : authStatus?.state === 'logged_out' ? 'signedOut' : 'unknown',
                    loginSupport: setupFacts.signIn.loginSupport,
                    ...(typeof authStatus?.accountLabel === 'string' ? { accountLabel: authStatus.accountLabel } : {}),
                },
                update: { supported: update?.updateSupported ?? false, command: update?.updateCommand ?? null },
                resolvedPath,
                resolutionSource,
                ...(readOnly ? { resolutionReadOnly: readOnly } : {}),
                ...(resolvedCommandResult !== CLI_SNAPSHOT_PROBE_TIMEOUT && typeof resolvedCommandResult === 'string'
                    ? { resolvedCommand: resolvedCommandResult }
                    : {}),
                ...(versionResult.version
                    ? { version: versionResult.version }
                    : {}),
                ...(includeLoginStatus ? { isLoggedIn } : {}),
                ...(includeLoginStatus ? { authStatus } : {}),
            };

            return [name, entry] as const;
        }),
    );

    const tmuxResolvedPath = !data.requestedTools || data.requestedTools.includes('tmux')
        ? resolveExecutableCommand('tmux', { env: environment, cwd }) : null;
    const tmux: DetectTmuxEntry = (() => {
        if (!tmuxResolvedPath) return { available: false };
        return { available: true, resolvedPath: tmuxResolvedPath };
    })();

    const windowsTerminalResolvedPath = !data.requestedTools || data.requestedTools.includes('windowsTerminal')
        ? resolveExecutableCommand('wt.exe', { env: environment, cwd }) : null;
    const windowsTerminal: DetectWindowsTerminalEntry = (() => {
        if (!windowsTerminalResolvedPath) return { available: false };
        return { available: true, resolvedPath: windowsTerminalResolvedPath };
    })();

    if (tmux.available && tmuxResolvedPath) {
        const version = await cliVersionCache.read({ name: 'tool:tmux', resolvedPath: tmuxResolvedPath, fresh, resolveCommand,
            probeKey: buildCliSnapshotEnvironmentKey({ requestedCliNames: [] }, environment, cwd),
            probe: async () => {
                const observed = await detectTmuxVersion({ resolvedPath: tmuxResolvedPath, env: environment, cwd });
                return { version: observed, successful: observed !== null };
            } });
        if (typeof version === 'string') {
            tmux.version = version;
        }
    }

    // A catalog Agent may have no native CLI, or its own probe may fail. That
    // observation cannot invalidate another Agent's completed install/auth facts.
    const pairEntries = Object.fromEntries(observations.map((observation, index) => observation.status === 'fulfilled'
        ? observation.value
        : [names[index], {
            available: false,
            detectionError: { code: 'cli-detection-failed', message: 'Agent CLI detection failed' },
        } satisfies DetectCliEntry])) as Partial<Record<DetectCliName, DetectCliEntry>>;
    // Retirement invalidates readiness, not the last admitted installation. A
    // replacement factory must be observed before publishing another install fact.
    for (const [name, observation] of nativeFactories) {
        const factory = observation.status === 'fulfilled' ? observation.value : null;
        if (!factory || factory.isCurrent()) continue;
        if (pairEntries[name]) pairEntries[name] = { available: false,
            detectionError: { code: 'cli-detection-failed', message: 'Agent runtime changed during detection' } };
    }

    return {
        path: pathEnv,
        clis: Object.fromEntries(
            (Object.keys(AGENTS) as DetectCliName[]).map((name) => [name, pairEntries[name] ?? { available: false }]),
        ) as Record<DetectCliName, DetectCliEntry>,
        tmux,
        windowsTerminal,
    };
    } catch {
        // Best-effort: never throw from a snapshot helper.
        const names = Object.keys(AGENTS) as DetectCliName[];
        const clis = Object.fromEntries(names.map((name) => [name, {
            available: false,
            detectionError: { code: 'cli-detection-failed', message: 'Agent CLI detection failed' },
        } satisfies DetectCliEntry])) as Record<DetectCliName, DetectCliEntry>;
        return { path: pathEnv, clis, tmux: { available: false }, windowsTerminal: { available: false } };
    }
}
