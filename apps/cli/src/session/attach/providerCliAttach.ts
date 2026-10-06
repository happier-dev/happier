import { stat } from 'node:fs/promises';
import { createConnection } from 'node:net';

import {
    execFileWithDeadline,
    resolveWindowsCommandInvocation,
    type CommandInvocation,
} from '@happier-dev/cli-common/process';
import type { CatalogAgentLookupId } from '@/agent/catalog/types';
import type {
    AttachAvailabilityRequestV1,
    AttachSessionMetadataV1,
} from '@happier-dev/agents';
import type {
    AgentProviderCliAttachReachabilityV1,
    AttachSurface,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { requireAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { logger } from '@/ui/logger';
import { launchBorrowedTerminalProcess, type TerminalSpawnProcess, type BorrowedTerminalProcessIdentity } from '@/terminal/host/borrowedTerminalProcess';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
import type { TerminalHostHandle, TerminalHostPreference } from '@happier-dev/agents';
import type { PreparedTerminalHostOwner } from '@/plugins/runtime/context/terminalHost';
import { SessionProviderCliAttachPrepareResultV1Schema } from '@happier-dev/protocol/sessions/control/sessionProviderCliAttachPrepareV1';
import type { SessionProviderCliAttachPrepareRequestV1 } from '@happier-dev/protocol';

const PROVIDER_ATTACH_STOP_GRACE_MS = 3_000;

type ProviderCliAttachHostFacts = Readonly<{ cliVersion: string | null }>;

export type ProviderCliAttachManagedServiceAccess = Readonly<{
    baseUrl: string;
    request(input: Readonly<{
        pathAndQuery: string;
        signal: AbortSignal;
    }>): Promise<Readonly<{ ok: boolean }>>;
    childEnvironment: Readonly<Record<string, string>>;
    isCurrent?(): boolean;
}>;

/** Host-owned managed custody, not a public Agent AttachSurface extension. */
export type HostProviderCliAttachRequest = Parameters<AttachSurface['attach']>[0] & Readonly<{
    onAttached(): Promise<void>;
    /** Strict controller observation owns custody; ordinary AttachSurface never publishes it. */
    terminalClient?: Readonly<{
        onStarted(identity: BorrowedTerminalProcessIdentity): Promise<void>;
        onExited(identity: BorrowedTerminalProcessIdentity): Promise<void>;
    }>;
    /** Captured host placement, supplied only by the admitted Session mode owner. */
    hostPresentation?: Readonly<{
        owner: PreparedTerminalHostOwner;
        preference: TerminalHostPreference;
        sessionName: string;
        workingDirectory: string;
        startupDeadline(): number;
        startupPollIntervalMs?: number;
        bindHost(handle: TerminalHostHandle): Promise<void>;
        waitForRetirement(handle: TerminalHostHandle, signal: AbortSignal): Promise<boolean>;
    }>;
    resolveManagedServiceAccess?(input: Readonly<{
        sessionId: string;
        targetBaseUrl: string;
        environmentKey: string;
        signal?: AbortSignal;
    }>): Promise<ProviderCliAttachManagedServiceAccess | null>;
}>;

export type HostProviderCliAttachSurface = AttachSurface & Readonly<{
    attachManaged(request: HostProviderCliAttachRequest): ReturnType<AttachSurface['attach']>;
    prepareInvocation(request: HostProviderCliAttachPreparationRequest): Promise<HostProviderCliAttachPreparation>;
}>;

export type HostProviderCliAttachPreparationRequest = Omit<HostProviderCliAttachRequest, 'onAttached' | 'hostPresentation' | 'terminalClient'>;
export type HostProviderCliAttachPreparation =
    | Extract<Awaited<ReturnType<AttachSurface['attach']>>, { ok: false }>
    | Readonly<{ ok: true; value: Readonly<{
        invocation: ReturnType<typeof resolveWindowsCommandInvocation>;
        childEnv: NodeJS.ProcessEnv;
        managedServiceAccess: ProviderCliAttachManagedServiceAccess | undefined;
    }> }>;

export function isHostProviderCliAttachSurface(surface: unknown): surface is HostProviderCliAttachSurface {
    return typeof surface === 'object' && surface !== null
        && 'attachManaged' in surface && typeof surface.attachManaged === 'function'
        && 'prepareInvocation' in surface && typeof surface.prepareInvocation === 'function';
}

/** Existing public Attach delegates managed observations to the controller, never writes its state. */
export async function attachObservedNativeClient(params: Readonly<{
    surface: HostProviderCliAttachSurface;
    request: Parameters<AttachSurface['attach']>[0];
    providerSessionId: string;
    herdr: NonNullable<SessionProviderCliAttachPrepareRequestV1['terminalClient']>['herdr'];
    observe: (request: SessionProviderCliAttachPrepareRequestV1) => Promise<unknown>;
}>): Promise<Awaited<ReturnType<AttachSurface['attach']>>> {
    const observe = async (terminalClient?: SessionProviderCliAttachPrepareRequestV1['terminalClient']) => {
        const parsed = SessionProviderCliAttachPrepareResultV1Schema.safeParse(await params.observe({
            providerSessionId: params.providerSessionId, ...(terminalClient ? { terminalClient } : {}),
        }));
        if (!parsed.success || !parsed.data.ok || parsed.data.providerSessionId !== params.providerSessionId) {
            throw new Error('Managed native terminal observation was not admitted');
        }
    };
    await observe();
    return await params.surface.attachManaged({ ...params.request, onAttached: async () => {},
        terminalClient: {
            onStarted: async launcher => await observe({ attached: true, herdr: params.herdr, launcher }),
            onExited: async launcher => await observe({ attached: false, herdr: params.herdr, launcher }),
        },
    });
}

async function readProviderCliVersion(params: Readonly<{
    launch: AgentCliLaunchSpec;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
}>): Promise<string | null> {
    try {
        const result = await execFileWithDeadline(
            params.launch.command,
            [...params.launch.args, ...params.args],
            {
                env: params.env,
                timeout: 5_000,
                windowsHide: true,
            },
        );
        const stdout = typeof result.stdout === 'string'
            ? result.stdout
            : result.stdout.toString('utf8');
        const normalized = stdout.trim();
        return normalized.length > 0 ? normalized : null;
    } catch {
        return null;
    }
}

export type ProviderCliAttachTargetResult<TTarget extends object> =
    | Readonly<{ ok: true; value: TTarget }>
    | Readonly<{ ok: false; reason: string }>;

export type ProviderCliAttachTargetResolver<TTarget extends object> = (params: Readonly<{
    metadata: AttachSessionMetadataV1;
    fallbackServerBaseUrl?: string | null;
}>) => ProviderCliAttachTargetResult<TTarget>;

export async function probeLocalSocket(
    path: string,
    timeoutMs: number,
    dependencies: Readonly<{
        platform?: NodeJS.Platform;
        statPath?: typeof stat;
    }> = {},
): Promise<boolean> {
    if ((dependencies.platform ?? process.platform) === 'win32') {
        try {
            await (dependencies.statPath ?? stat)(path);
            return true;
        } catch {
            return false;
        }
    }
    return await new Promise<boolean>((resolve) => {
        const socket = createConnection(path);
        let settled = false;
        const finish = (reachable: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.destroy();
            resolve(reachable);
        };
        const timeout = setTimeout(() => finish(false), timeoutMs);
        timeout.unref?.();
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

function isLocalAttachRequest(request: AttachAvailabilityRequestV1): boolean {
    if (request.hasLocalAttachmentInfo === true) return true;
    if (
        request.currentMachineId
        && request.sessionMachineId
        && request.currentMachineId === request.sessionMachineId
    ) {
        return true;
    }
    return false;
}

async function readFallbackServerBaseUrl(params: Readonly<{
    sessionId: string;
    readFallbackServerBaseUrl?: (
        input: Readonly<{ sessionId: string }>,
    ) => Promise<string | null>;
}>): Promise<string | null> {
    if (!params.readFallbackServerBaseUrl) return null;
    try {
        const value = await params.readFallbackServerBaseUrl({ sessionId: params.sessionId });
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    } catch {
        return null;
    }
}

async function resolveTargetWithFallback<TTarget extends object>(params: Readonly<{
    metadata: AttachSessionMetadataV1;
    sessionId: string;
    resolver: ProviderCliAttachTargetResolver<TTarget>;
    readFallbackServerBaseUrl?: (
        input: Readonly<{ sessionId: string }>,
    ) => Promise<string | null>;
}>): Promise<ProviderCliAttachTargetResult<TTarget>> {
    const fallbackServerBaseUrl = await readFallbackServerBaseUrl({
        sessionId: params.sessionId,
        readFallbackServerBaseUrl: params.readFallbackServerBaseUrl,
    });
    return params.resolver({
        metadata: params.metadata,
        fallbackServerBaseUrl,
    });
}

export function createProviderCliAttachSurface<TTarget extends object>(params: Readonly<{
    agentId: CatalogAgentLookupId;
    resolveTarget: ProviderCliAttachTargetResolver<TTarget>;
    createArgs: (target: TTarget, host: ProviderCliAttachHostFacts) => readonly string[];
    resolveReachability?: (
        target: TTarget,
        host: ProviderCliAttachHostFacts,
    ) => AgentProviderCliAttachReachabilityV1 | null;
    cliVersionArgs?: readonly string[];
    resolveCliVersion?: (input: Readonly<{
        launch: AgentCliLaunchSpec;
        args: readonly string[];
        env: NodeJS.ProcessEnv;
    }>) => Promise<string | null>;
    readFallbackServerBaseUrl?: (
        input: Readonly<{ sessionId: string }>,
    ) => Promise<string | null>;
    managedServiceTargetBaseUrl?: (target: TTarget) => string | null;
    managedServiceCredentialEnvironmentKey?: string;
    managedServiceCredentialEnvironmentAliases?: readonly string[];
    resolveManagedServiceAccess?: (input: Readonly<{
        sessionId: string;
        targetBaseUrl: string;
    }>) => Promise<ProviderCliAttachManagedServiceAccess | null>;
    resolveLaunchSpec?: (
        env?: NodeJS.ProcessEnv,
    ) => AgentCliLaunchSpec | Promise<AgentCliLaunchSpec>;
    resolveCommandInvocation?: (params: Readonly<{
        command: string;
        args: readonly string[];
        env?: NodeJS.ProcessEnv;
    }>) => CommandInvocation;
    spawnProcess?: TerminalSpawnProcess;
    fetchFn?: typeof fetch;
    probeSocket?: (path: string, timeoutMs: number) => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    reachabilityTimeoutMs?: number;
}>): HostProviderCliAttachSurface {
    const resolveReachability = params.resolveReachability;
    const resolveInvocation = params.resolveCommandInvocation ?? resolveWindowsCommandInvocation;
    const resolveLaunch = async (env: NodeJS.ProcessEnv): Promise<AgentCliLaunchSpec> => await (
        params.resolveLaunchSpec ?? ((processEnv) =>
            requireAgentCliLaunchSpec(params.agentId, { processEnv }))
    )(env);
    const resolveHostFacts = async (
        env: NodeJS.ProcessEnv,
        selectedLaunch?: AgentCliLaunchSpec,
    ): Promise<ProviderCliAttachHostFacts> => {
        if (!params.cliVersionArgs) return Object.freeze({ cliVersion: null });
        const launch = selectedLaunch ?? await resolveLaunch(env);
        return Object.freeze({
            cliVersion: await (params.resolveCliVersion ?? readProviderCliVersion)({
                launch,
                args: params.cliVersionArgs,
                env,
            }),
        });
    };
    const resolveExactManagedServiceAccess = async (
        sessionId: string,
        target: TTarget,
        hostRequest?: HostProviderCliAttachPreparationRequest,
    ): Promise<ProviderCliAttachManagedServiceAccess | null | undefined> => {
        const targetBaseUrl = params.managedServiceTargetBaseUrl?.(target);
        if (!targetBaseUrl) return undefined;
        try {
            const access = hostRequest?.resolveManagedServiceAccess
                ? params.managedServiceCredentialEnvironmentKey
                    ? await hostRequest.resolveManagedServiceAccess({
                        sessionId, targetBaseUrl,
                        environmentKey: params.managedServiceCredentialEnvironmentKey,
                        ...(hostRequest.signal ? { signal: hostRequest.signal } : {}),
                    })
                    : null
                : await params.resolveManagedServiceAccess?.({ sessionId, targetBaseUrl });
            if (!access || access.isCurrent?.() === false) return null;
            return new URL(access.baseUrl).toString()
                === new URL(targetBaseUrl).toString()
                ? access
                : null;
        } catch {
            return null;
        }
    };
    const evaluateAvailability: NonNullable<AttachSurface['evaluateAvailability']> = async (request) => {
            const target = await resolveTargetWithFallback({
                metadata: request.metadata,
                sessionId: request.sessionId,
                resolver: params.resolveTarget,
                readFallbackServerBaseUrl: isLocalAttachRequest(request)
                    ? params.readFallbackServerBaseUrl
                    : undefined,
            });
            if (!target.ok) {
                return {
                    available: false,
                    reasonCode: 'missing_metadata',
                    safeMessage: target.reason,
                };
            }
            if (request.depth === 'live') {
                if (!resolveReachability) {
                    return {
                        available: false,
                        reasonCode: 'unsupported',
                        safeMessage: 'Provider attach reachability is unavailable.',
                    };
                }
                const reachability = resolveReachability(
                    target.value,
                    await resolveHostFacts(params.env ?? process.env),
                );
                if (!reachability) {
                    return {
                        available: false,
                        reasonCode: 'missing_metadata',
                        safeMessage: 'Provider attach reachability metadata is invalid.',
                    };
                }

                const timeoutMs = params.reachabilityTimeoutMs ?? 1_500;
                const reachable = reachability.kind === 'localSocket'
                    ? await (params.probeSocket ?? probeLocalSocket)(reachability.path, timeoutMs)
                    : await (async () => {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), timeoutMs);
                        timeout.unref?.();
                        try {
                            const access = await resolveExactManagedServiceAccess(
                                request.sessionId,
                                target.value,
                            );
                            if (access === null) return false;
                            if (access) {
                                const targetUrl = new URL(reachability.url);
                                const accessUrl = new URL(access.baseUrl);
                                if (targetUrl.origin !== accessUrl.origin) return false;
                                return (await access.request({
                                    pathAndQuery: `${targetUrl.pathname}${targetUrl.search}`,
                                    signal: controller.signal,
                                })).ok;
                            }
                            return Boolean((await (params.fetchFn ?? fetch)(reachability.url, {
                                method: 'GET',
                                signal: controller.signal,
                            }).catch(() => null))?.ok);
                        } finally {
                            clearTimeout(timeout);
                        }
                    })();
                if (!reachable) {
                    return {
                        available: false,
                        reasonCode: 'agent_unavailable',
                        retryable: true,
                        safeMessage: 'Provider attach target is unreachable.',
                    };
                }
            }
            return { available: true };
    };
    const prepareInvocation = async (request: HostProviderCliAttachPreparationRequest): Promise<HostProviderCliAttachPreparation> => {
            const { metadata, sessionId, signal } = request;
            signal?.throwIfAborted();
            const target = await resolveTargetWithFallback({
                metadata,
                sessionId,
                resolver: params.resolveTarget,
                readFallbackServerBaseUrl: params.readFallbackServerBaseUrl,
            });
            if (!target.ok) {
                return {
                    ok: false,
                    code: 'attach_failed',
                    message: target.reason,
                };
            }

            const env = params.env ?? process.env;
            const managedServiceAccess = await resolveExactManagedServiceAccess(
                sessionId,
                target.value,
                request,
            );
            if (managedServiceAccess === null) {
                return {
                    ok: false,
                    code: 'attach_failed',
                    message: 'Provider attach managed-service access is unavailable.',
                };
            }
            const childEnv = finalizeSessionChildEnvironment({
                environment: env,
                enableCgroupSelfMigration: false,
                stackProcessKind: null,
            });
            const credentialEnvironmentKey =
                params.managedServiceCredentialEnvironmentKey;
            const credentialEnvironmentDestinations = credentialEnvironmentKey
                ? [
                    credentialEnvironmentKey,
                    ...(params.managedServiceCredentialEnvironmentAliases ?? []),
                ]
                : [];
            if (managedServiceAccess && credentialEnvironmentKey) {
                for (const environmentKey of credentialEnvironmentDestinations) {
                    delete childEnv[environmentKey];
                }
                const materializedCredential =
                    managedServiceAccess.childEnvironment[credentialEnvironmentKey];
                if (typeof materializedCredential === 'string') {
                    for (const environmentKey of credentialEnvironmentDestinations) {
                        childEnv[environmentKey] = materializedCredential;
                    }
                }
            }
            const launch = await resolveLaunch(childEnv);
            const invocation = resolveInvocation({
                command: launch.command,
                args: [
                    ...launch.args,
                    ...params.createArgs(target.value, await resolveHostFacts(childEnv, launch)),
                ],
                env: childEnv,
            });
            signal?.throwIfAborted();
            if (managedServiceAccess?.isCurrent?.() === false) {
                return { ok: false, code: 'attach_failed', message: 'Provider attach managed-service access is unavailable.' };
            }
            return { ok: true, value: { invocation, childEnv, managedServiceAccess } };
    };
    const attach = async (request: Parameters<AttachSurface['attach']>[0] | HostProviderCliAttachRequest): Promise<Awaited<ReturnType<AttachSurface['attach']>>> => {
            const { metadata, sessionId, signal } = request;
            const onAttached = 'onAttached' in request ? request.onAttached : undefined;
            const terminalClient = 'onAttached' in request ? request.terminalClient : undefined;
            const hostPresentation = 'onAttached' in request ? request.hostPresentation : undefined;
            const startupDeadline = hostPresentation?.startupDeadline();
            if (signal?.aborted) return { ok: true, value: { exitCode: 0 } };
            let prepared: HostProviderCliAttachPreparation;
            try { prepared = await prepareInvocation(request); }
            catch (error) {
                if (signal?.aborted) return { ok: true, value: { exitCode: 0 } };
                throw error;
            }
            if (!prepared.ok) return prepared;
            const { invocation, childEnv, managedServiceAccess } = prepared.value;
            if (hostPresentation) {
                const localAbort = new AbortController();
                const retiredAbort = new AbortController();
                const ownerSignal = AbortSignal.any([localAbort.signal, ...(signal ? [signal] : [])]);
                const startupSignal = AbortSignal.any([ownerSignal, retiredAbort.signal]);
                let created: Awaited<ReturnType<PreparedTerminalHostOwner['createPreparedHost']>> | null = null;
                let physicallyRetired = false;
                let phase = 'prepare_native';
                try {
                    created = await hostPresentation.owner.createPreparedHost({
                        preference: hostPresentation.preference, sessionName: hostPresentation.sessionName,
                        workingDirectory: hostPresentation.workingDirectory,
                        spawnArgv: [invocation.command, ...invocation.args],
                        spawnEnv: Object.fromEntries(Object.entries(childEnv).filter(
                            (entry): entry is [string, string] => typeof entry[1] === 'string',
                        )),
                        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                        signal: ownerSignal,
                        beforeSpawn: () => {
                            if (managedServiceAccess?.isCurrent?.() === false) throw new Error('Provider managed-service access was withdrawn');
                        },
                    });
                    phase = 'bind_host';
                    await hostPresentation.bindHost(created.handle);
                    const retirement = hostPresentation.waitForRetirement(created.handle, ownerSignal).then(retired => {
                        physicallyRetired = retired;
                        if (retired) retiredAbort.abort();
                        return retired;
                    });
                    void retirement.catch(() => undefined);
                    phase = 'await_native_spawn';
                    const status = await created.launch.awaitNativeSpawnResult!(
                        startupDeadline!, hostPresentation.startupPollIntervalMs, startupSignal,
                    );
                    if (physicallyRetired || ownerSignal.aborted) return { ok: true, value: { exitCode: 0 } };
                    if (status !== 'spawned') throw new Error('Native presentation startup was not confirmed');
                    phase = 'publish_attached';
                    await onAttached?.();
                    // Actual native startup owns the live presentation. Private cleanup
                    // failure is already observable at the artifact owner and is nonfatal.
                    await created.launch.discard().catch(() => undefined);
                    phase = 'wait_for_retirement';
                    await retirement;
                    return { ok: true, value: { exitCode: 0 } };
                } catch {
                    logger.infoFile('[provider-attach] Hosted native presentation unavailable', {
                        error: 'managed_provider_attach_startup_failed', sessionId, phase,
                    });
                    return signal?.aborted
                        ? { ok: true, value: { exitCode: 0 } }
                        : { ok: false, code: 'attach_failed', message: 'Hosted native presentation startup failed.' };
                } finally {
                    // Cancel pending receipt/lifecycle work before awaiting exact disposal.
                    localAbort.abort();
                    if (created) await hostPresentation.owner.dispose(created.handle, physicallyRetired
                        ? { kind: 'preserve_host', reason: 'runtime_recovery' }
                        : { kind: 'destroy_owned_host', reason: 'session_closed' });
                }
            }
            let child: Awaited<ReturnType<typeof launchBorrowedTerminalProcess>>;
            try {
                child = await launchBorrowedTerminalProcess({
                    spawnArgv: [invocation.command, ...invocation.args],
                    workingDirectory: process.cwd(),
                    spawnEnv: Object.fromEntries(Object.entries(childEnv).filter(
                        (entry): entry is [string, string] => typeof entry[1] === 'string',
                    )),
                    envPassthroughKeys: [],
                    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                    beforeSpawn: () => {
                        if (managedServiceAccess?.isCurrent?.() === false) {
                            throw new Error('Provider managed-service access was withdrawn');
                        }
                    },
                    ...(params.spawnProcess ? { spawnProcess: params.spawnProcess } : {}),
                    ...(signal ? { signal } : {}),
                });
            } catch {
                return signal?.aborted
                    ? { ok: true, value: { exitCode: 0 } }
                    : { ok: false, code: 'attach_failed', message: 'Provider native attach startup failed.' };
            }

            let startupFailed = false;
            let clientAdmitted = false;
            const exitCode = await new Promise<number>((resolve, reject) => {
                let stopTimer: NodeJS.Timeout | null = null;
                let startupPublication: Promise<void> | null = null;
                let finished = false;
                const finish = (code: number): void => {
                    if (finished) return;
                    finished = true;
                    if (stopTimer) {
                        clearTimeout(stopTimer);
                        stopTimer = null;
                    }
                    signal?.removeEventListener('abort', stop);
                    void Promise.resolve(startupPublication).then(async () => {
                        if (clientAdmitted && child.launcherIdentity) await terminalClient?.onExited(child.launcherIdentity);
                        resolve(code);
                    }).catch(reject);
                };
                const stop = (): void => {
                    void child.signal('SIGINT').catch(() => {
                        logger.infoFile('[provider-attach] Failed to signal foreground attach process', {
                            error: 'provider_attach_cleanup_signal_failed', sessionId, signal: 'SIGINT',
                        });
                        // The exit/error event remains the authoritative settlement.
                    });
                    stopTimer = setTimeout(() => {
                        if (finished) return;
                        void child.signal('SIGKILL').catch(() => {
                            logger.infoFile('[provider-attach] Failed to signal foreground attach process', {
                                error: 'provider_attach_cleanup_signal_failed', sessionId, signal: 'SIGKILL',
                            });
                            // The exit/error event remains the authoritative settlement.
                        });
                    }, PROVIDER_ATTACH_STOP_GRACE_MS);
                    stopTimer.unref?.();
                };
                if (onAttached || terminalClient) {
                    startupPublication = Promise.resolve().then(async () => {
                        if (signal?.aborted) throw new Error('Managed attach startup cancelled');
                        if (terminalClient) {
                            if (!child.launcherIdentity) throw new Error('Native launcher custody is unavailable');
                            await terminalClient.onStarted(child.launcherIdentity);
                            clientAdmitted = true;
                        }
                        await onAttached?.();
                    }).catch(() => {
                        startupFailed = true;
                        if (!finished) stop();
                    });
                }
                void child.whenExited.then(
                    ({ code }) => finish(typeof code === 'number' ? code : 1),
                    (error: unknown) => {
                        finished = true;
                        if (stopTimer) clearTimeout(stopTimer);
                        signal?.removeEventListener('abort', stop);
                        reject(error);
                    },
                );
                signal?.addEventListener('abort', stop, { once: true });
                if (signal?.aborted) stop();
            });
            return startupFailed
                ? { ok: false, code: 'attach_failed', message: 'Managed provider attach startup failed.' }
                : { ok: true, value: { exitCode } };
    };
    return { evaluateAvailability, attach, attachManaged: attach, prepareInvocation };
}
