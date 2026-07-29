import type {
    AgentSessionHostServices,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type {
    TerminalHostAdapter,
    TerminalHostHandle,
    TerminalHostPreference,
    TerminalInputInjectionResult,
    TerminalPromptInput,
} from '@happier-dev/agents';
import {
    prepareTerminalPromptTextForInjection,
    resolveTerminalPromptWriteTimeoutMs,
} from '@happier-dev/agents';

import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { resolveTerminalHost } from '@/integrations/terminal/host/resolveTerminalHost';
import type { TerminalHostResolution } from '@/integrations/terminal/host/_types';
import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import {
    readTerminalHostAttachmentInfo,
    writeTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import {
    executeTerminalHostDisposition,
    resolveRuntimeTerminalHostDispositionIntent,
} from '@/terminal/attachment/terminalHostDisposition';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/terminal/attachment/catalogHooks';
import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import {
    requireAgentCliLaunchSpec,
    type AgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
import { selectTrustedSessionControlEnvironment } from '@/session/runtime/control/sessionControlEnvironment';
import { logger } from '@/ui/logger';

type AgentTerminalHostService = NonNullable<AgentSessionHostServices['terminalHost']>;
type AgentTerminalHostCreateOrAttachRequest =
    Parameters<AgentTerminalHostService['createOrAttachHost']>[0];
type AgentTerminalHostDisposeIntent = Parameters<AgentTerminalHostService['dispose']>[1];
type AgentTerminalHostLaunchInput = AgentTerminalHostCreateOrAttachRequest['launch'];
type AgentTerminalHostResolveResult = Awaited<ReturnType<AgentTerminalHostService['resolve']>>;
type AgentTerminalHostResolutionReason =
    Extract<AgentTerminalHostResolveResult, { reason: unknown }>['reason'];

export type PluginTerminalHostErrorCode =
    | 'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED'
    | 'PLUGIN_TERMINAL_HOST_SCOPE_RETIRED'
    | 'PLUGIN_TERMINAL_HOST_UNAVAILABLE'
    | 'PLUGIN_TERMINAL_HOST_UNRESOLVED_LAUNCH'
    | 'PLUGIN_TERMINAL_HOST_HANDLE_NOT_ACTIVE'
    | 'PLUGIN_TERMINAL_HOST_HANDLE_KIND_MISMATCH'
    | 'PLUGIN_TERMINAL_HOST_UNSUPPORTED_LAUNCH';

export class PluginTerminalHostError extends Error {
    readonly code: PluginTerminalHostErrorCode;

    constructor(code: PluginTerminalHostErrorCode, message: string) {
        super(message);
        this.name = 'PluginTerminalHostError';
        this.code = code;
    }
}

export type CreatePluginTerminalHostServiceParams = Readonly<{
    hasCapability: (capability: string) => boolean;
    resolveTerminalHost: (preference: TerminalHostPreference) => TerminalHostResolution | Promise<TerminalHostResolution>;
    resolveAgentCliLaunch: (launch: AgentTerminalHostLaunchInput) => Pick<AgentCliLaunchSpec, 'command' | 'args'> & Readonly<{
        env?: Readonly<Record<string, string>>;
    }>;
    onHostCreated?: (handle: TerminalHostHandle) => Promise<TerminalHostHandle | void> | TerminalHostHandle | void;
    disposeHost: (input: Readonly<{
        handle: TerminalHostHandle;
        adapter: TerminalHostAdapter;
        intent: AgentTerminalHostDisposeIntent;
    }>) => Promise<void> | void;
}>;

export type CreateDefaultPluginTerminalHostServiceParams = Readonly<{
    happyHomeDir: string;
    hasCapability: (capability: string) => boolean;
    readSessionId?: () => string | null;
    resolvePromptSubmitVerification?: (() => Promise<TerminalPromptSubmitVerificationPolicy | null>) | undefined;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
}>;

type ActiveTerminalHost = Readonly<{
    adapter: TerminalHostAdapter;
    handle: TerminalHostHandle;
}>;

const TERMINAL_HOST_CAPABILITY = 'terminalHost';
const TERMINAL_HOST_CONTROL_PERMISSION = 'terminal.host.control';

function assertCapability(params: CreatePluginTerminalHostServiceParams): void {
    if (
        !params.hasCapability(TERMINAL_HOST_CAPABILITY)
        || !params.hasCapability(TERMINAL_HOST_CONTROL_PERMISSION)
    ) {
        throw new PluginTerminalHostError(
            'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED',
            `ctx.terminalHost requires '${TERMINAL_HOST_CAPABILITY}' runtime capability and '${TERMINAL_HOST_CONTROL_PERMISSION}' permission`,
        );
    }
}

function toPublicResolution(resolution: TerminalHostResolution): AgentTerminalHostResolveResult {
    if (resolution.status === 'disabled') {
        return {
            status: 'disabled',
            reason: resolution.reason as AgentTerminalHostResolutionReason,
            message: resolution.message,
        };
    }
    return {
        status: 'resolved',
        hostKind: resolution.adapter.kind,
        reason: resolution.reason as AgentTerminalHostResolutionReason,
    };
}

function mergeLaunchEnv(
    hostEnv: Readonly<Record<string, string>> | undefined,
    pluginEnv: AgentTerminalHostLaunchInput['env'],
    unsetEnvKeys: AgentTerminalHostLaunchInput['unsetEnvKeys'],
): Readonly<Record<string, string>> {
    return Object.freeze(finalizeSessionChildEnvironment({
        environment: buildScopedProcessEnv({
            baseEnv: hostEnv ?? {},
            explicitEnv: pluginEnv,
            unsetEnvKeys,
        }),
        canonicalSessionControlEnvironment: selectTrustedSessionControlEnvironment(hostEnv ?? {}),
        enableCgroupSelfMigration: false,
        stackProcessKind: null,
    }) as Record<string, string>);
}

function resolveActiveHost(
    activeHosts: ReadonlyMap<TerminalHostHandle, ActiveTerminalHost>,
    handle: TerminalHostHandle,
): ActiveTerminalHost {
    const active = activeHosts.get(handle);
    if (!active) {
        throw new PluginTerminalHostError(
            'PLUGIN_TERMINAL_HOST_HANDLE_NOT_ACTIVE',
            'ctx.terminalHost received a handle that is not active for this plugin runtime',
        );
    }
    if (active.adapter.kind !== handle.kind) {
        throw new PluginTerminalHostError(
            'PLUGIN_TERMINAL_HOST_HANDLE_KIND_MISMATCH',
            'ctx.terminalHost handle kind does not match the resolved terminal host adapter',
        );
    }
    return active;
}

function handleFields(
    handle: TerminalHostHandle,
): Pick<
    Extract<TerminalInputInjectionResult, { status: 'failed' }>,
    'hostKind' | 'hostSessionName' | 'paneId'
> {
    return {
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
    };
}

function invalidPromptTextResult(
    handle: TerminalHostHandle,
    observedAt: number,
): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
    return {
        status: 'failed',
        reason: 'invalid_prompt_text',
        phase: 'before_write',
        duplicateRisk: 'none',
        recoverable: false,
        observedAt,
        ...handleFields(handle),
    };
}

function preparePromptInputForAdapter(input: TerminalPromptInput): TerminalPromptInput | null {
    const prepared = prepareTerminalPromptTextForInjection(input.text);
    if (!prepared.ok) return null;
    return {
        ...input,
        text: prepared.text,
        multiline: prepared.multiline,
        scheduling: {
            ...input.scheduling,
            timeoutMs: input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(prepared.text),
        },
    };
}

async function requireResolvedHost(
    params: CreatePluginTerminalHostServiceParams,
    preference: TerminalHostPreference,
): Promise<Extract<TerminalHostResolution, { status: 'resolved' }>> {
    const resolution = await params.resolveTerminalHost(preference);
    if (resolution.status === 'disabled') {
        throw new PluginTerminalHostError(
            'PLUGIN_TERMINAL_HOST_UNAVAILABLE',
            resolution.message,
        );
    }
    return resolution;
}

export function createPluginTerminalHostService(
    params: CreatePluginTerminalHostServiceParams,
): AgentTerminalHostService {
    const activeHosts = new Map<TerminalHostHandle, ActiveTerminalHost>();

    return Object.freeze({
        async resolve(request: Parameters<AgentTerminalHostService['resolve']>[0]) {
            assertCapability(params);
            return toPublicResolution(await params.resolveTerminalHost(request.preference));
        },
        async createOrAttachHost(request: AgentTerminalHostCreateOrAttachRequest) {
            assertCapability(params);
            if (request.launch.kind !== 'agent-cli') {
                throw new PluginTerminalHostError(
                    'PLUGIN_TERMINAL_HOST_UNSUPPORTED_LAUNCH',
                    'ctx.terminalHost can only launch host-resolved agent CLIs',
                );
            }
            const resolution = await requireResolvedHost(params, request.preference);
            const launch = params.resolveAgentCliLaunch(request.launch);
            if (!launch.command || launch.command.trim().length === 0) {
                throw new PluginTerminalHostError(
                    'PLUGIN_TERMINAL_HOST_UNRESOLVED_LAUNCH',
                    'ctx.terminalHost could not resolve an agent CLI launch command',
                );
            }
            const createdHandle = await resolution.adapter.createOrAttachHost({
                sessionName: request.sessionName,
                workingDirectory: request.workingDirectory,
                spawnArgv: [
                    launch.command,
                    ...launch.args,
                    ...(request.launch.args ?? []),
                ],
                spawnEnv: mergeLaunchEnv(
                    launch.env,
                    request.launch.env,
                    request.launch.unsetEnvKeys,
                ),
                ...(request.launch.unsetEnvKeys
                    ? { unsetEnvKeys: request.launch.unsetEnvKeys }
                    : {}),
                isolatedEnv: request.isolatedEnv,
            });
            let handle = createdHandle;
            try {
                handle = await params.onHostCreated?.(createdHandle) ?? createdHandle;
            } catch (error) {
                await resolution.adapter.dispose(createdHandle).catch(() => {});
                throw error;
            }
            activeHosts.set(handle, { adapter: resolution.adapter, handle });
            return handle;
        },
        async injectUserPrompt(
            handle: Parameters<AgentTerminalHostService['injectUserPrompt']>[0],
            input: Parameters<AgentTerminalHostService['injectUserPrompt']>[1],
        ) {
            const active = resolveActiveHost(activeHosts, handle);
            const preparedInput = preparePromptInputForAdapter(input);
            if (preparedInput === null) {
                return invalidPromptTextResult(active.handle, Date.now());
            }
            return active.adapter.injectUserPrompt(active.handle, preparedInput);
        },
        async interruptTurn(handle: Parameters<AgentTerminalHostService['interruptTurn']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            await active.adapter.interruptTurn(active.handle);
        },
        async evaluateLiveness(handle: Parameters<AgentTerminalHostService['evaluateLiveness']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            return active.adapter.evaluateLiveness(active.handle);
        },
        async captureInputState(handle: Parameters<AgentTerminalHostService['captureInputState']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            if (!active.adapter.captureInputState) return null;
            return active.adapter.captureInputState(active.handle);
        },
        async controlPort(handle: Parameters<AgentTerminalHostService['controlPort']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            if (!active.adapter.createControlPort) return null;
            return active.adapter.createControlPort(active.handle);
        },
        async dispose(
            handle: Parameters<AgentTerminalHostService['dispose']>[0],
            intent: Parameters<AgentTerminalHostService['dispose']>[1],
        ) {
            const active = resolveActiveHost(activeHosts, handle);
            await params.disposeHost({ handle: active.handle, adapter: active.adapter, intent });
            activeHosts.delete(handle);
        },
    });
}

async function resolveDefaultTerminalHost(
    params: CreateDefaultPluginTerminalHostServiceParams,
    preference: TerminalHostPreference,
): Promise<TerminalHostResolution> {
    const platform = params.platform ?? process.platform;
    const promptSubmitVerification = await params.resolvePromptSubmitVerification?.() ?? null;
    const inventory = await createDefaultTerminalHostAdapterInventory({
        happyHomeDir: params.happyHomeDir,
        preference,
        platform,
        ...(promptSubmitVerification ? { promptSubmitVerification } : {}),
    });

    return resolveTerminalHost({
        preference,
        platform: {
            os: platform,
            arch: params.arch ?? process.arch,
        },
        adapters: inventory.adapters,
        tmuxAvailable: inventory.tmuxAvailable,
        zellijAvailable: inventory.zellijAvailable,
    });
}

function buildProviderCliProcessEnv(input: AgentTerminalHostLaunchInput): NodeJS.ProcessEnv {
    return buildScopedProcessEnv({
        baseEnv: process.env,
        explicitEnv: input.env,
        unsetEnvKeys: input.unsetEnvKeys,
    });
}

export function createDefaultPluginTerminalHostService(
    params: CreateDefaultPluginTerminalHostServiceParams,
): AgentTerminalHostService {
    return createPluginTerminalHostService({
        hasCapability: params.hasCapability,
        resolveTerminalHost: (preference) => resolveDefaultTerminalHost(params, preference),
        resolveAgentCliLaunch: (launch) => requireAgentCliLaunchSpec(launch.agentId as CatalogAgentLookupId, {
            processEnv: buildProviderCliProcessEnv(launch),
        }),
        onHostCreated: async (handle) => {
            const sessionId = params.readSessionId?.()?.trim() ?? '';
            if (!sessionId) return;
            const attachmentInfo = await writeTerminalHostAttachmentInfo({
                happyHomeDir: params.happyHomeDir,
                sessionId,
                handle,
            });
            return attachmentInfo.handle;
        },
        disposeHost: async ({ handle, adapter, intent }) => {
            const sessionId = params.readSessionId?.()?.trim() ?? '';
            const attachmentId = handle.attachmentId;
            const mustDestroyExactHost = intent.kind === 'destroy_owned_host';
            if (!sessionId || !attachmentId) {
                if (mustDestroyExactHost) {
                    throw new Error('Exact terminal-host disposal requires persisted session and attachment identity');
                }
                return;
            }
            const attachmentInfo = await readTerminalHostAttachmentInfo({
                happyHomeDir: params.happyHomeDir,
                sessionId,
            });
            if (attachmentInfo?.version !== 2 || attachmentInfo.attachmentId !== attachmentId) {
                if (mustDestroyExactHost) {
                    throw new Error('Exact terminal-host disposal could not confirm the current attachment identity');
                }
                return;
            }
            const disposition = await executeTerminalHostDisposition({
                happyHomeDir: params.happyHomeDir,
                sessionId,
                expectedAttachmentId: attachmentId,
                intent: resolveRuntimeTerminalHostDispositionIntent(intent),
                adapter,
            });
            if (mustDestroyExactHost && disposition.status !== 'destroyed') {
                const failure = disposition.status === 'parked' ? disposition.reason : disposition.status;
                throw new Error(`Exact terminal-host disposal did not complete: ${failure}`);
            }
            if (disposition.status === 'destroyed') {
                await notifyTerminalAttachmentRetiredThroughCatalog({
                    happyHomeDir: params.happyHomeDir,
                    sessionId,
                    attachmentInfo,
                }).catch((error) => {
                    // Host retirement is already irreversible; provider cleanup remains advisory.
                    logger.warn('[PLUGIN TERMINAL HOST] Provider artifacts could not be cleaned after exact host retirement', error);
                });
            }
        },
    });
}
