import type {
    ExecAgentCliLaunchInputV1,
    TerminalHostCreateOrAttachRequestV1,
    TerminalHostResolutionReasonV1,
    TerminalHostResolveResultV1,
    TerminalHostRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';
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
import { createTerminalHostRegistry } from '@/integrations/terminal/host/registry';
import { resolveTerminalHost } from '@/integrations/terminal/host/resolveTerminalHost';
import type { TerminalHostResolution } from '@/integrations/terminal/host/_types';
import { createTmuxTerminalHostAdapter, isTmuxAvailable } from '@/integrations/tmux';
import {
    createZellijTerminalHostAdapter,
    prepareZellijSocketDir,
    resolveZellijRuntimeBinary,
    resolveZellijSocketDir,
} from '@/integrations/zellij';
import { createPtyTerminalHostAdapter } from '@/terminal/pty/hostAdapter';
import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import {
    requireProviderCliLaunchSpec,
    type ProviderCliLaunchSpec,
} from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

export type PluginTerminalHostErrorCode =
    | 'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED'
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
    resolveAgentCliLaunch: (launch: ExecAgentCliLaunchInputV1) => Pick<ProviderCliLaunchSpec, 'command' | 'args'> & Readonly<{
        env?: Readonly<Record<string, string>>;
    }>;
}>;

export type CreateDefaultPluginTerminalHostServiceParams = Readonly<{
    happyHomeDir: string;
    hasCapability: (capability: string) => boolean;
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

function toPublicResolution(resolution: TerminalHostResolution): TerminalHostResolveResultV1 {
    if (resolution.status === 'disabled') {
        return {
            status: 'disabled',
            reason: resolution.reason as TerminalHostResolutionReasonV1,
            message: resolution.message,
        };
    }
    return {
        status: 'resolved',
        hostKind: resolution.adapter.kind,
        reason: resolution.reason as TerminalHostResolutionReasonV1,
    };
}

function mergeLaunchEnv(
    hostEnv: Readonly<Record<string, string>> | undefined,
    pluginEnv: ExecAgentCliLaunchInputV1['env'],
): Readonly<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const source of [hostEnv, pluginEnv]) {
        for (const [key, value] of Object.entries(source ?? {})) {
            if (typeof value === 'string') {
                env[key] = value;
            }
        }
    }
    return Object.freeze(env);
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
): TerminalHostRuntimeServiceV1 {
    const activeHosts = new Map<TerminalHostHandle, ActiveTerminalHost>();

    return Object.freeze({
        async resolve(request: Parameters<TerminalHostRuntimeServiceV1['resolve']>[0]) {
            assertCapability(params);
            return toPublicResolution(await params.resolveTerminalHost(request.preference));
        },
        async createOrAttachHost(request: TerminalHostCreateOrAttachRequestV1) {
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
            const handle = await resolution.adapter.createOrAttachHost({
                sessionName: request.sessionName,
                workingDirectory: request.workingDirectory,
                spawnArgv: [
                    launch.command,
                    ...launch.args,
                    ...(request.launch.args ?? []),
                ],
                spawnEnv: mergeLaunchEnv(launch.env, request.launch.env),
                isolatedEnv: request.isolatedEnv,
            });
            activeHosts.set(handle, { adapter: resolution.adapter, handle });
            return handle;
        },
        async injectUserPrompt(
            handle: Parameters<TerminalHostRuntimeServiceV1['injectUserPrompt']>[0],
            input: Parameters<TerminalHostRuntimeServiceV1['injectUserPrompt']>[1],
        ) {
            const active = resolveActiveHost(activeHosts, handle);
            const preparedInput = preparePromptInputForAdapter(input);
            if (preparedInput === null) {
                return invalidPromptTextResult(active.handle, Date.now());
            }
            return active.adapter.injectUserPrompt(active.handle, preparedInput);
        },
        async interruptTurn(handle: Parameters<TerminalHostRuntimeServiceV1['interruptTurn']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            await active.adapter.interruptTurn(active.handle);
        },
        async evaluateLiveness(handle: Parameters<TerminalHostRuntimeServiceV1['evaluateLiveness']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            return active.adapter.evaluateLiveness(active.handle);
        },
        async captureInputState(handle: Parameters<TerminalHostRuntimeServiceV1['captureInputState']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            if (!active.adapter.captureInputState) return null;
            return active.adapter.captureInputState(active.handle);
        },
        async controlPort(handle: Parameters<TerminalHostRuntimeServiceV1['controlPort']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            if (!active.adapter.createControlPort) return null;
            return active.adapter.createControlPort(active.handle);
        },
        async dispose(handle: Parameters<TerminalHostRuntimeServiceV1['dispose']>[0]) {
            const active = resolveActiveHost(activeHosts, handle);
            activeHosts.delete(handle);
            await active.adapter.dispose(active.handle);
        },
    });
}

async function resolveDefaultTerminalHost(
    params: CreateDefaultPluginTerminalHostServiceParams,
    preference: TerminalHostPreference,
): Promise<TerminalHostResolution> {
    const adapters: TerminalHostAdapter[] = [];
    const platform = params.platform ?? process.platform;
    const promptSubmitVerification = await params.resolvePromptSubmitVerification?.() ?? null;
    const tmuxAvailable = platform === 'win32' ? false : await isTmuxAvailable();
    if (tmuxAvailable) {
        adapters.push(createTmuxTerminalHostAdapter({
            ...(promptSubmitVerification ? { promptSubmitVerification } : {}),
        }));
    }

    if (platform === 'win32') {
        adapters.push(createPtyTerminalHostAdapter());
    }

    const shouldConfigureZellij = platform !== 'win32' || preference === 'zellij';
    const zellijBinary = shouldConfigureZellij ? await resolveZellijRuntimeBinary() : null;
    if (zellijBinary) {
        const socketDir = resolveZellijSocketDir(params.happyHomeDir);
        await prepareZellijSocketDir(socketDir);
        adapters.push(createZellijTerminalHostAdapter({
            zellijBinary,
            socketDir,
            ...(promptSubmitVerification ? { promptSubmitVerification } : {}),
        }));
    }

    return resolveTerminalHost({
        preference,
        platform: {
            os: platform,
            arch: params.arch ?? process.arch,
        },
        adapters: createTerminalHostRegistry(adapters),
        tmuxAvailable,
        zellijAvailable: zellijBinary !== null,
    });
}

function buildProviderCliProcessEnv(input: ExecAgentCliLaunchInputV1): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(input.env ?? {})) {
        if (typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}

export function createDefaultPluginTerminalHostService(
    params: CreateDefaultPluginTerminalHostServiceParams,
): TerminalHostRuntimeServiceV1 {
    return createPluginTerminalHostService({
        hasCapability: params.hasCapability,
        resolveTerminalHost: (preference) => resolveDefaultTerminalHost(params, preference),
        resolveAgentCliLaunch: (launch) => requireProviderCliLaunchSpec(launch.agentId as CatalogAgentLookupId, {
            processEnv: buildProviderCliProcessEnv(launch),
        }),
    });
}
