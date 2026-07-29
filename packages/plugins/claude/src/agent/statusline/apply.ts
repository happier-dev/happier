import type { ClaudeEffectiveModelEvidence } from '../runtime/effectiveModelEvidence.js';
import type { ClaudeStatuslinePayload } from './payload.js';

/**
 * Consumes Claude statusline payloads (pushed by the statusline forwarder wrapper) and feeds
 * them into the native effective-model and runtime-truth semantic sinks.
 *
 * Statusline is FASTER than transcript model adoption and is the only DIRECT source of the max
 * context window (`context_window.context_window_size`). Everything here is additive
 * enrichment: sessions without statusline data keep the catalog/observed-usage fallbacks.
 */

export type ClaudeStatuslineIdentity = Readonly<{
    providerSessionId: string | null;
    transcriptPath: string | null;
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

export type ClaudeEffectiveModelChange = Readonly<{
    modelId: string;
    previousModelId: string | null;
    eventId: string;
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

export function createClaudeStatuslineApplier(params: Readonly<{
    logger: ClaudeStatuslineApplierLogger;
    readIdentity: () => ClaudeStatuslineIdentity;
    onRuntimeTruth?: (truth: ClaudeStatuslineRuntimeTruth) => void;
    onEffectiveModel?: (evidence: ClaudeEffectiveModelEvidence) => void;
    onModelChanged?: (change: ClaudeEffectiveModelChange) => void;
}>): Readonly<{
    apply(payload: ClaudeStatuslinePayload): void;
    applyModelEvidence(input: Readonly<{
        modelId: string | null;
        displayName?: string | null | undefined;
        contextWindowTokens?: number | null | undefined;
    }>): void;
}> {
    let lastModelKey: string | null = null;
    let lastCanaryKey: string | null = null;
    let lastRuntimeTruthKey: string | null = null;
    let lastObservedModelId: string | null = null;
    const publishedModelChangeEventIds = new Set<string>();

    const maybeAdoptModelAndWindow = (input: Readonly<{
        modelId: string | null;
        displayName?: string | null | undefined;
        contextWindowTokens?: number | null | undefined;
    }>): void => {
        const modelId = readString(input.modelId);
        if (!modelId) return;
        const contextWindowTokens = readPositiveTokens(input.contextWindowTokens);
        const displayName = readString(input.displayName);

        // Dedupe: identical payloads (~300ms debounce upstream, but state changes repeat the same
        // model/window) must not spam metadata writes.
        const modelKey = `${modelId}|${contextWindowTokens ?? ''}`;
        if (modelKey === lastModelKey) return;
        lastModelKey = modelKey;

        params.onEffectiveModel?.({
            modelId,
            ...(displayName ? { displayName } : {}),
            ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
        });
        const previousModelId = lastObservedModelId;
        lastObservedModelId = modelId;
        if (params.onModelChanged && previousModelId !== null && previousModelId !== modelId) {
            const eventId = `claude-model-changed:${previousModelId}:${modelId}`;
            if (!publishedModelChangeEventIds.has(eventId)) {
                publishedModelChangeEventIds.add(eventId);
                params.onModelChanged({ modelId, previousModelId, eventId });
            }
        }
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
            maybeAdoptModelAndWindow({
                modelId: payload.model?.id ?? null,
                displayName: payload.model?.display_name ?? null,
                contextWindowTokens: payload.context_window?.context_window_size ?? null,
            });
            maybeFeedRuntimeTruth(payload);
            maybeLogRuntimeCanary(payload);
        },
        applyModelEvidence(input) {
            maybeAdoptModelAndWindow(input);
        },
    };
}
