import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import type { UsageObservationTokens } from '@happier-dev/protocol';
import type { TeamCredentialRequestProtocolKindV1 } from '@happier-dev/protocol/teams';

/**
 * The public external Provider route has no Session turn and no Agent usage
 * publisher, so the only terminal token fact that exists for one of its
 * requests is the one the Provider itself puts in the admitted response. This
 * reader observes that response exactly once, on the single pass the terminal
 * outcome observer already makes, and converts the Provider's own usage block
 * for the routes whose protocol guarantees one.
 *
 * It never derives, estimates or completes a number the Provider did not
 * report: an absent or unparseable usage block leaves the observation unknown,
 * which the terminal report carries as `measurement: 'unavailable'`.
 */
export type ExternalProviderTerminalTokenObservation = Readonly<{
    outcome: 'succeeded' | 'failed';
    actualModelId: string | null;
    tokens: UsageObservationTokens | null;
}>;

export type ExternalProviderTerminalTokenReader = Readonly<{
    push(chunk: Uint8Array): void;
    read(): ExternalProviderTerminalTokenObservation;
}>;

type JsonObject = Record<string, unknown>;

// Route conformance: Responses and Messages carry terminal usage on every
// admitted request. A streamed Chat Completion carries it only when the caller
// sent `stream_options.include_usage`, which the broker never adds, so that
// request stays `unavailable` and the server keeps the resource-wide external
// token capability closed (`usageCapabilities.ts`, the single decision owner).

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readModelId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= PROVIDER_ENDPOINT_SAFETY_LIMITS.maxHeaderValueChars
        ? trimmed
        : null;
}

function nestedCount(container: unknown, key: string): number | null {
    return isObject(container) ? readCount(container[key]) : null;
}

/**
 * Anthropic Messages reports each half of the request separately and never
 * folds cache reads or writes into `input_tokens`, so the Happier total is
 * their sum — the same convention the Claude Agent observation already uses.
 */
function anthropicTokens(usage: JsonObject): UsageObservationTokens | null {
    const input = readCount(usage.input_tokens);
    const output = readCount(usage.output_tokens);
    const cacheRead = readCount(usage.cache_read_input_tokens);
    const cacheWrite = readCount(usage.cache_creation_input_tokens);
    if (input === null || output === null) return null;
    return Object.freeze({
        input,
        output,
        reasoning: 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
        total: input + output + (cacheRead ?? 0) + (cacheWrite ?? 0),
    });
}

/**
 * Both OpenAI protocols count cached input inside the prompt/input total and
 * reasoning inside the completion/output total, and both publish the authored
 * `total_tokens`; that reported total is preserved rather than recomputed.
 */
function openAiTokens(
    usage: JsonObject,
    fields: Readonly<{
        input: string;
        output: string;
        inputDetails: string;
        outputDetails: string;
        cached: string;
    }>,
): UsageObservationTokens | null {
    const input = readCount(usage[fields.input]);
    const output = readCount(usage[fields.output]);
    const total = readCount(usage.total_tokens);
    if (input === null || output === null || total === null) return null;
    const cacheRead = nestedCount(usage[fields.inputDetails], fields.cached);
    const reasoning = nestedCount(usage[fields.outputDetails], 'reasoning_tokens');
    return Object.freeze({
        input,
        output,
        reasoning: reasoning ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: 0,
        total,
    });
}

function routeTokens(
    routeKind: TeamCredentialRequestProtocolKindV1,
    usage: unknown,
): UsageObservationTokens | null {
    if (!isObject(usage)) return null;
    if (routeKind === 'anthropic_messages') return anthropicTokens(usage);
    if (routeKind === 'openai_responses') {
        return openAiTokens(usage, {
            input: 'input_tokens',
            output: 'output_tokens',
            inputDetails: 'input_tokens_details',
            outputDetails: 'output_tokens_details',
            cached: 'cached_tokens',
        });
    }
    return openAiTokens(usage, {
        input: 'prompt_tokens',
        output: 'completion_tokens',
        inputDetails: 'prompt_tokens_details',
        outputDetails: 'completion_tokens_details',
        cached: 'cached_tokens',
    });
}

function parseJsonObject(text: string): JsonObject | null {
    try {
        const value: unknown = JSON.parse(text);
        return isObject(value) ? value : null;
    } catch {
        return null;
    }
}

export function createExternalProviderTerminalTokenReader(input: Readonly<{
    routeKind: TeamCredentialRequestProtocolKindV1;
    contentType: string | null;
}>): ExternalProviderTerminalTokenReader {
    const streamed = (input.contentType ?? '').toLowerCase().includes('text/event-stream');
    const decoder = new TextDecoder('utf-8');
    // The observer never HOLDS more than the canonical Provider body budget:
    // the whole body when it is one JSON document, one unterminated event when
    // it is a stream (drained events are released). A long stream of small
    // events therefore stays observed; one held value beyond the budget leaves
    // the observation unknown rather than growing the daemon's memory with a
    // response it is merely passing through.
    const budget = PROVIDER_ENDPOINT_SAFETY_LIMITS.maxDecodedBodyBytes;
    let overflowed = false;
    let pending = '';
    let modelId: string | null = null;
    let tokens: UsageObservationTokens | null = null;
    let completed = false;
    let failed = false;
    let anthropicInitialTokens: UsageObservationTokens | null = null;
    let anthropicFinalOutput: number | null = null;

    const observeStreamedPayload = (payload: JsonObject): void => {
        if (payload.type === 'error' || payload.error != null) {
            failed = true;
            return;
        }
        if (input.routeKind === 'anthropic_messages') {
            if (payload.type === 'message_start' && isObject(payload.message)) {
                modelId = readModelId(payload.message.model);
                anthropicInitialTokens = routeTokens(input.routeKind, payload.message.usage);
            } else if (payload.type === 'message_delta' && isObject(payload.usage)) {
                anthropicFinalOutput = readCount(payload.usage.output_tokens);
            } else if (payload.type === 'message_stop') {
                completed = true;
            }
            return;
        }
        if (input.routeKind === 'openai_responses') {
            if (payload.type === 'response.failed' || payload.type === 'response.incomplete') {
                failed = true;
            } else if (payload.type === 'response.completed' && isObject(payload.response)) {
                completed = true;
                if (payload.response.error != null
                    || (payload.response.status != null && payload.response.status !== 'completed')) {
                    failed = true;
                } else {
                    modelId = readModelId(payload.response.model);
                    tokens = routeTokens(input.routeKind, payload.response.usage);
                }
            }
            return;
        }
        modelId = readModelId(payload.model) ?? modelId;
        // Only the final include_usage chunk reports the whole Chat request.
        if (Array.isArray(payload.choices) && payload.choices.length === 0) {
            tokens = routeTokens(input.routeKind, payload.usage);
        }
    };

    const observeStreamedData = (data: string): void => {
        if (data === '[DONE]' && input.routeKind === 'openai_chat_completions') {
            completed = true;
            return;
        }
        const payload = parseJsonObject(data);
        if (payload) observeStreamedPayload(payload);
    };

    const drainStreamedLines = (final: boolean): void => {
        for (;;) {
            const breakIndex = pending.indexOf('\n');
            if (breakIndex < 0) break;
            const line = pending.slice(0, breakIndex).trimEnd();
            pending = pending.slice(breakIndex + 1);
            if (!line.startsWith('data:')) continue;
            observeStreamedData(line.slice('data:'.length).trim());
        }
        if (!final || !pending.startsWith('data:')) return;
        observeStreamedData(pending.slice('data:'.length).trim());
        pending = '';
    };

    return Object.freeze({
        push(chunk: Uint8Array): void {
            if (overflowed) return;
            pending += decoder.decode(chunk, { stream: true });
            if (streamed) drainStreamedLines(false);
            // UTF-16 length bounds the held UTF-8 bytes from below, so this
            // never fires early; it fires once the held text is at least the budget.
            if (pending.length > budget) {
                overflowed = true;
                pending = '';
            }
        },
        read(): ExternalProviderTerminalTokenObservation {
            if (overflowed) {
                return Object.freeze({ outcome: failed || !completed ? 'failed' : 'succeeded', actualModelId: null, tokens: null });
            }
            pending += decoder.decode();
            if (streamed) {
                drainStreamedLines(true);
                failed ||= !completed;
                if (input.routeKind === 'anthropic_messages' && anthropicInitialTokens && anthropicFinalOutput !== null) {
                    tokens = Object.freeze({
                        ...anthropicInitialTokens,
                        output: anthropicFinalOutput,
                        total: anthropicInitialTokens.input + anthropicFinalOutput
                            + anthropicInitialTokens.cacheRead + anthropicInitialTokens.cacheWrite,
                    });
                }
            } else {
                const payload = parseJsonObject(pending);
                if (payload) {
                    failed = payload.type === 'error' || payload.error != null
                        || (input.routeKind === 'openai_responses'
                            && ['failed', 'incomplete', 'cancelled'].includes(String(payload.status)));
                    completed = input.routeKind === 'openai_responses'
                        ? payload.status === 'completed'
                        : input.routeKind === 'anthropic_messages'
                            ? payload.type === 'message' && typeof payload.stop_reason === 'string' && payload.stop_reason.length > 0
                            : Array.isArray(payload.choices) && payload.choices.length > 0
                                && payload.choices.every((choice) => isObject(choice)
                                    && typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0);
                    modelId = readModelId(payload.model);
                    if (completed) {
                        tokens = routeTokens(input.routeKind, payload.usage);
                    }
                }
                failed ||= !completed;
                pending = '';
            }
            return failed
                ? Object.freeze({ outcome: 'failed', actualModelId: null, tokens: null })
                : Object.freeze({ outcome: 'succeeded', actualModelId: modelId, tokens });
        },
    });
}
