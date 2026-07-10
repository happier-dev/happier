import type {
    AgentRuntimeV1,
    CreateExecutionRunBackendParamsV1,
    CreateSessionRuntimeParamsV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { createClaudeExecutionRunBackend } from '../executionRuns/createClaudeExecutionRunBackend.js';
import { claudeExternalSessionSurface } from '../surfaces/sessions/external/providerOps.js';
import { claudeHandoffSurface } from '../surfaces/sessions/handoff/providerOps.js';
import { createClaudeOutboundTranscriptDispatchFacet } from '../transcripts/outbound.js';
import { buildClaudeRemoteOutgoingMessageMetaExtras } from './messageMeta.js';
import { bindClaudeAgentSdkFallbackSession } from './remote/sdk/session.js';
import { bindClaudeUnifiedTerminalSession } from './terminal/unified/bindSession.js';

const CLAUDE_UNIFIED_TERMINAL_FEATURE_ID = 'agents.claude.unifiedTerminal';
const CLAUDE_UNIFIED_TERMINAL_SETTING_KEY = 'claudeUnifiedTerminalEnabled';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    return null;
}

async function readClaudeUnifiedTerminalSetting(ctx: PluginContextV1): Promise<boolean | null> {
    try {
        return readBoolean(await ctx.settings.get(CLAUDE_UNIFIED_TERMINAL_SETTING_KEY));
    } catch {
        return null;
    }
}

async function isClaudeUnifiedTerminalSelected(
    ctx: PluginContextV1,
    sessionParams: CreateSessionRuntimeParamsV1,
): Promise<boolean> {
    if (!ctx.features.isEnabled(CLAUDE_UNIFIED_TERMINAL_FEATURE_ID)) {
        return false;
    }

    const metadata = isRecord(sessionParams.metadata) ? sessionParams.metadata : null;
    const metadataEnabled = readBoolean(metadata?.[CLAUDE_UNIFIED_TERMINAL_SETTING_KEY]);
    const settingsEnabled = metadataEnabled ?? await readClaudeUnifiedTerminalSetting(ctx);

    return settingsEnabled === true;
}

export function createClaudeBackendEngine(ctx: PluginContextV1): AgentRuntimeV1 {
    return Object.freeze({
        runtimeCore: Object.freeze({
            async createSessionRuntime(sessionParams: CreateSessionRuntimeParamsV1) {
                if (await isClaudeUnifiedTerminalSelected(ctx, sessionParams)) {
                    return await bindClaudeUnifiedTerminalSession({ ctx, sessionParams });
                }
                return await bindClaudeAgentSdkFallbackSession({ ctx, sessionParams });
            },
            createExecutionRunBackend(executionRunParams: CreateExecutionRunBackendParamsV1) {
                return createClaudeExecutionRunBackend({
                    ctx,
                    executionRunParams,
                });
            },
        }),
        messageMeta: Object.freeze({
            buildOutgoingMessageMetaExtras: buildClaudeRemoteOutgoingMessageMetaExtras,
        }),
        externalSessionSurface: claudeExternalSessionSurface,
        handoffSurface: claudeHandoffSurface,
        facets: Object.freeze({
            transcriptDispatch: createClaudeOutboundTranscriptDispatchFacet(),
        }),
    });
}
