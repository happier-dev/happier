import type {
    TerminalRuntimeControlProjectionV1,
    TerminalRuntimeProjectionHostServiceV1,
    TerminalRuntimeSubagentProjectionV1,
} from '@happier-dev/agents';

import { normalizeCodexTerminalSessionId } from './invocation.js';

export const CODEX_TERMINAL_PROVIDER_SESSION_METADATA_KEY = 'codexSessionId';
export const CODEX_TERMINAL_NATIVE_SUBAGENT_PROVIDER_KIND = 'codex-native-subagent';

export type CodexTerminalSubagentOutcome = 'completed' | 'interrupted';

export type CodexTerminalSubagentStartProjection = Readonly<{
    threadId: string;
    prompt?: string | null;
    nickname?: string | null;
    role?: string | null;
}>;

export type CodexTerminalSubagentCompletionProjection = Readonly<{
    threadId: string;
    status: CodexTerminalSubagentOutcome;
    summaryText?: string | null;
}>;

export type CodexTerminalRuntimeProjection = Readonly<{
    openDirectTranscriptMirror: TerminalRuntimeProjectionHostServiceV1['openDirectTranscriptMirror'];
    publishCodexSessionId(value: unknown): Promise<boolean>;
    publishControlState(projection: TerminalRuntimeControlProjectionV1): Promise<void>;
    publishSubagentStarted(projection: CodexTerminalSubagentStartProjection): Promise<void>;
    publishSubagentCompleted(projection: CodexTerminalSubagentCompletionProjection): Promise<void>;
}>;

function normalizeText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildSubagentMetadata(
    projection: CodexTerminalSubagentStartProjection | Pick<CodexTerminalSubagentCompletionProjection, 'threadId'>,
): Readonly<Record<string, unknown>> {
    const metadata: Record<string, unknown> = {
        threadId: projection.threadId,
    };
    if ('prompt' in projection && projection.prompt) {
        metadata.prompt = projection.prompt;
    }
    if ('nickname' in projection && projection.nickname) {
        metadata.nickname = projection.nickname;
    }
    if ('role' in projection && projection.role) {
        metadata.role = projection.role;
    }
    return Object.freeze(metadata);
}

function buildSubagentStartProjection(
    projection: CodexTerminalSubagentStartProjection,
): TerminalRuntimeSubagentProjectionV1 | null {
    const threadId = normalizeText(projection.threadId);
    if (!threadId) {
        return null;
    }
    const nickname = normalizeText(projection.nickname);
    const role = normalizeText(projection.role);
    const prompt = normalizeText(projection.prompt);
    return Object.freeze({
        providerId: 'codex',
        providerKind: CODEX_TERMINAL_NATIVE_SUBAGENT_PROVIDER_KIND,
        subagentId: threadId,
        sidechainId: threadId,
        label: nickname ?? role ?? 'Codex subagent',
        ...(role ? { role } : {}),
        metadata: buildSubagentMetadata({
            threadId,
            ...(prompt ? { prompt } : {}),
            ...(nickname ? { nickname } : {}),
            ...(role ? { role } : {}),
        }),
    });
}

function buildSubagentCompletionProjection(
    projection: CodexTerminalSubagentCompletionProjection,
): TerminalRuntimeSubagentProjectionV1 | null {
    const threadId = normalizeText(projection.threadId);
    if (!threadId) {
        return null;
    }
    const status = projection.status === 'interrupted' ? 'aborted' : 'completed';
    return Object.freeze({
        providerId: 'codex',
        providerKind: CODEX_TERMINAL_NATIVE_SUBAGENT_PROVIDER_KIND,
        subagentId: threadId,
        sidechainId: threadId,
        status,
        lifecycleDetail: {
            providerState: projection.status,
            reason: projection.status === 'interrupted' ? 'provider_interrupted' : 'provider_completed',
            ...(projection.summaryText ? { summaryText: projection.summaryText } : {}),
        },
        metadata: buildSubagentMetadata({ threadId }),
    });
}

export function createCodexTerminalRuntimeProjection(
    params: Readonly<{ projection: TerminalRuntimeProjectionHostServiceV1 }>,
): CodexTerminalRuntimeProjection {
    return Object.freeze({
        openDirectTranscriptMirror: params.projection.openDirectTranscriptMirror,
        publishCodexSessionId: async (value) => {
            const providerSessionId = normalizeCodexTerminalSessionId(value);
            if (!providerSessionId) {
                return false;
            }
            return await params.projection.publishProviderSessionId({
                providerSessionId,
                metadataKey: CODEX_TERMINAL_PROVIDER_SESSION_METADATA_KEY,
            });
        },
        publishControlState: async (projection) => {
            await params.projection.publishControlState(projection);
        },
        publishSubagentStarted: async (projection) => {
            const mapped = buildSubagentStartProjection(projection);
            if (!mapped) {
                return;
            }
            await params.projection.publishSubagentStarted(mapped);
        },
        publishSubagentCompleted: async (projection) => {
            const mapped = buildSubagentCompletionProjection(projection);
            if (!mapped) {
                return;
            }
            await params.projection.publishSubagentCompleted(mapped);
        },
    });
}
