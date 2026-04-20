import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { PermissionRequestPushSender } from '@/agent/permissions/BasePermissionHandler';
import type { Credentials } from '@/persistence';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AccountSettings } from '@happier-dev/protocol';

import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';

import { createCodexPermissionHandler, type CodexRuntimePermissionHandler } from '../../utils/createCodexPermissionHandler';
import { applyPermissionModeToCodexPermissionHandler } from '../../utils/applyPermissionModeToHandler';
import { DiffProcessor } from '../../utils/diffProcessor';
import { forwardCodexErrorToUi as forwardCodexErrorToUiShared, forwardCodexStatusToUi as forwardCodexStatusToUiShared } from '../mcpMessageHandler';
import { resolveCodexMcpServerSpawn } from '../../mcp/resolveCodexMcpServerSpawn';
import { buildCodexAppServerConfigOverrides } from '../../appServer/buildCodexAppServerConfigOverrides';

import type { CodexMcpClient } from '../../mcp/sessionClient';

export type SetupCodexRemoteRuntimeContextResult = Readonly<{
    directory: string;
    mcpServers: Awaited<ReturnType<typeof resolveRunnerMcpServers>>['mcpServers'];
    happierMcpServer: { url: string; stop: () => void } | null;
    codexAppServerProcessEnv: NodeJS.ProcessEnv;
    codexAppServerConfigOverrides: string[];
    client: CodexMcpClient | null;
    permissionHandler: CodexRuntimePermissionHandler;
    diffProcessor: DiffProcessor;
    resolveFreshSessionSystemPrompt: (baseOverride?: string | null) => Promise<string>;
    forwardStatusToUi: (messageText: string) => void;
    forwardErrorToUi: (errorText: string) => void;
}>;

export async function setupCodexRemoteRuntimeContext(params: {
    session: ApiSessionClient;
    credentials: Credentials;
    accountSettings: AccountSettings | null;
    machineId: string;
    directory: string;
    promptArtifactBodyCache: Map<string, string | null>;
    messageBuffer: MessageBuffer;
    pushSender: PermissionRequestPushSender | null;
    getAccountSettings: () => AccountSettings | null;
    getAccountSettingsSecretsReadKeys: () => ReadonlyArray<Uint8Array | null | undefined>;
    handleAbort: () => void | Promise<void>;
    useCodexAcp: boolean;
    useCodexAppServer: boolean;
    initialPermissionMode: PermissionMode;
    currentPermissionMode: PermissionMode | undefined;
    currentPermissionModeUpdatedAt: number;
}): Promise<SetupCodexRemoteRuntimeContextResult> {
    const { session } = params;

    // Start Happier MCP server (HTTP) and prepare STDIO bridge config for Codex.
    const happierBridge = await resolveRunnerMcpServers({
        session,
        credentials: params.credentials,
        accountSettings: params.accountSettings,
        machineId: params.machineId,
        directory: params.directory,
        sessionMetadata: session.getMetadataSnapshot(),
        commandMode: 'current-process',
    });

    const mcpServers = happierBridge.mcpServers;
    const codexAppServerProcessEnv = process.env;
    const codexAppServerConfigOverrides = params.useCodexAppServer
        ? buildCodexAppServerConfigOverrides(mcpServers)
        : [];

    const resolveFreshSessionSystemPrompt = async (baseOverride?: string | null): Promise<string> =>
        await resolveEffectiveCodingPromptText({
            credentials: params.credentials,
            settings: params.getAccountSettings(),
            profileId: session.getMetadataSnapshot()?.profileId ?? null,
            baseOverride,
            executionRunsFeatureEnabled:
                resolveCliFeatureDecision({
                    featureId: 'execution.runs',
                    env: process.env,
                }).state === 'enabled',
            providerId: 'codex',
            cache: params.promptArtifactBodyCache,
        });

    let client: CodexMcpClient | null = null;
    if (!params.useCodexAcp && !params.useCodexAppServer) {
        const codexMcpServer = await resolveCodexMcpServerSpawn();
        const { CodexMcpClient: CodexMcpClientClass } = await import('../../mcp/sessionClient');
        client = new CodexMcpClientClass({ mode: codexMcpServer.mode, command: codexMcpServer.command });
    }

    const toolTraceProtocol: import('@/agent/tools/trace/toolTrace').ToolTraceProtocol = params.useCodexAcp ? 'acp' : 'codex';
    const permissionHandler = createCodexPermissionHandler({
        session,
        pushSender: params.pushSender,
        getAccountSettings: params.getAccountSettings,
        getAccountSettingsSecretsReadKeys: params.getAccountSettingsSecretsReadKeys,
        onAbortRequested: params.handleAbort,
        toolTrace: { protocol: toolTraceProtocol, provider: 'codex' },
        triggerAbortCallbackOnAbortDecision: params.useCodexAcp,
    });
    applyPermissionModeToCodexPermissionHandler({
        permissionHandler,
        permissionMode: params.currentPermissionMode ?? params.initialPermissionMode,
        permissionModeUpdatedAt: params.currentPermissionModeUpdatedAt,
    });

    const diffProcessor = new DiffProcessor((message) => {
        session.sendCodexMessage(message);
    });

    if (client) {
        client.setPermissionHandler(permissionHandler);
    }

    const forwardStatusToUi = (messageText: string): void => {
        forwardCodexStatusToUiShared({
            messageBuffer: params.messageBuffer,
            session,
            messageText,
        });
    };

    const forwardErrorToUi = (errorText: string): void => {
        forwardCodexErrorToUiShared({
            messageBuffer: params.messageBuffer,
            session,
            errorText,
        });
    };

    return {
        directory: params.directory,
        mcpServers,
        happierMcpServer: happierBridge.happierMcpServer,
        codexAppServerProcessEnv,
        codexAppServerConfigOverrides,
        client,
        permissionHandler,
        diffProcessor,
        resolveFreshSessionSystemPrompt,
        forwardStatusToUi,
        forwardErrorToUi,
    };
}
