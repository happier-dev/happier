import type { ClaudeSessionModelsState } from '../sessionControls/models.js';
import type { ClaudeStatuslinePayload } from './payload.js';

/**
 * Consumes Claude statusline payloads (pushed by the statusline forwarder wrapper) and feeds
 * them into the session-models metadata the UI already prefers for model identity and the
 * context window (`sessionModelsV1`; see `resolveContextWarningWindowTokens` UI-side).
 *
 * Statusline is FASTER than transcript model adoption and is the only DIRECT source of the max
 * context window (`context_window.context_window_size`). Everything here is additive
 * enrichment: sessions without statusline data keep the catalog/observed-usage fallbacks.
 */

export type ClaudeStatuslineIdentity = Readonly<{
    providerSessionId: string | null;
    transcriptPath: string | null;
}>;

export type ClaudeStatuslineMetadataWriteRequest = Readonly<{
    kind: 'update';
    handler: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
    reason?: string;
}>;

export type ClaudeStatuslineApplierLogger = Readonly<{
    debug(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
}>;

/**
 * Verified effective runtime truth observed on the statusline (the `lastVerified` analogue):
 * what the live TUI is ACTUALLY running. Consumers may fold this into convergence baselines
 * only — never into desired-state surfaces.
 */
export type ClaudeStatuslineRuntimeTruth = Readonly<{
    modelId: string | null;
    effortLevel: string | null;
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveTokens(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/**
 * Stale/foreign payload guard. Statusline fires immediately at TUI start — possibly before the
 * SessionStart hook adopted the Claude session id — so an unidentified session accepts payloads,
 * while a session with a known identity rejects payloads matching neither the Claude session id
 * nor the transcript path (the id rotates on fork/compact; the transcript path is the steadier key).
 */
function matchesSession(identity: ClaudeStatuslineIdentity, payload: ClaudeStatuslinePayload): boolean {
    const payloadSessionId = readString(payload.session_id);
    const payloadTranscriptPath = readString(payload.transcript_path);
    const knownSessionId = readString(identity.providerSessionId);
    const knownTranscriptPath = readString(identity.transcriptPath);

    if (payloadSessionId && knownSessionId && payloadSessionId === knownSessionId) return true;
    if (payloadTranscriptPath && knownTranscriptPath && payloadTranscriptPath === knownTranscriptPath) return true;
    return !knownSessionId && !knownTranscriptPath;
}

function readSessionModelsState(metadata: Readonly<Record<string, unknown>>): ClaudeSessionModelsState | null {
    const state = metadata.sessionModelsV1;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const record = state as Record<string, unknown>;
    if (record.v !== 1 || record.provider !== 'claude') return null;
    return record as unknown as ClaudeSessionModelsState;
}

function upsertSessionModelsState(params: Readonly<{
    current: Readonly<Record<string, unknown>>;
    modelId: string;
    displayName: string | null;
    contextWindowTokens: number | null;
    nowMs: number;
}>): Readonly<Record<string, unknown>> {
    const existing = readSessionModelsState(params.current);
    const availableModels = existing && Array.isArray(existing.availableModels)
        ? [...existing.availableModels]
        : [];
    const index = availableModels.findIndex((model) => model?.id === params.modelId);
    const previous = index >= 0 ? availableModels[index] : null;
    const entry = {
        ...(previous ?? {}),
        id: params.modelId,
        name: params.displayName ?? previous?.name ?? params.modelId,
        ...(params.contextWindowTokens !== null
            ? { contextWindowTokens: params.contextWindowTokens }
            : {}),
    };
    if (index >= 0) {
        availableModels[index] = entry;
    } else {
        availableModels.push(entry);
    }

    const next: ClaudeSessionModelsState = {
        v: 1,
        provider: 'claude',
        updatedAt: params.nowMs,
        currentModelId: params.modelId,
        availableModels,
    };
    return { ...params.current, sessionModelsV1: next };
}

export function createClaudeStatuslineApplier(params: Readonly<{
    logger: ClaudeStatuslineApplierLogger;
    writeMetadata: (request: ClaudeStatuslineMetadataWriteRequest) => Promise<void>;
    readIdentity: () => ClaudeStatuslineIdentity;
    nowMs?: () => number;
    onRuntimeTruth?: (truth: ClaudeStatuslineRuntimeTruth) => void;
}>): Readonly<{
    apply(payload: ClaudeStatuslinePayload): void;
}> {
    let lastModelKey: string | null = null;
    let lastCanaryKey: string | null = null;
    let lastRuntimeTruthKey: string | null = null;
    const nowMs = params.nowMs ?? (() => Date.now());

    const maybeAdoptModelAndWindow = (payload: ClaudeStatuslinePayload): void => {
        const modelId = readString(payload.model?.id);
        if (!modelId) return;
        const contextWindowTokens = readPositiveTokens(payload.context_window?.context_window_size);
        const displayName = readString(payload.model?.display_name);

        // Dedupe: identical payloads (~300ms debounce upstream, but state changes repeat the same
        // model/window) must not spam metadata writes.
        const modelKey = `${modelId}|${contextWindowTokens ?? ''}`;
        if (modelKey === lastModelKey) return;
        lastModelKey = modelKey;

        void params.writeMetadata({
            kind: 'update',
            handler: (current) => upsertSessionModelsState({
                current,
                modelId,
                displayName,
                contextWindowTokens,
                nowMs: nowMs(),
            }),
            reason: 'claude_statusline_model_update',
        }).catch((error) => {
            params.logger.warn('[ClaudeStatusline] session-models metadata update failed', error);
        });
    };

    const maybeFeedRuntimeTruth = (payload: ClaudeStatuslinePayload): void => {
        if (!params.onRuntimeTruth) return;
        const modelId = readString(payload.model?.id);
        const effortLevel = readString(payload.effort?.level);
        if (!modelId && !effortLevel) return;
        // Own dedup key: the metadata dedup (`model|window`) cannot see effort changes, so the
        // runtime-truth feed keys on `model|effort` to keep convergence baselines current.
        const truthKey = `${modelId ?? ''}|${effortLevel ?? ''}`;
        if (truthKey === lastRuntimeTruthKey) return;
        lastRuntimeTruthKey = truthKey;
        params.onRuntimeTruth({ modelId, effortLevel });
    };

    const maybeLogRuntimeCanary = (payload: ClaudeStatuslinePayload): void => {
        const canary = {
            version: payload.version ?? null,
            exceeds200k: payload.exceeds_200k_tokens ?? null,
            fastMode: payload.fast_mode ?? null,
            thinking: payload.thinking?.enabled ?? null,
            effort: payload.effort?.level ?? null,
        };
        const canaryKey = JSON.stringify(canary);
        if (canaryKey === lastCanaryKey) return;
        lastCanaryKey = canaryKey;
        // Drift canary + diagnostics: one debounced (change-only) file-log line, never console noise.
        params.logger.debug('[ClaudeStatusline] statusline runtime state', canary);
    };

    return {
        apply(payload) {
            if (!matchesSession(params.readIdentity(), payload)) {
                params.logger.debug('[ClaudeStatusline] ignoring statusline payload from foreign/stale Claude session', {
                    payloadSessionId: payload.session_id ?? null,
                    knownSessionId: params.readIdentity().providerSessionId,
                });
                return;
            }
            maybeAdoptModelAndWindow(payload);
            maybeFeedRuntimeTruth(payload);
            maybeLogRuntimeCanary(payload);
        },
    };
}
