import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import {
    redactVoiceToolResultValue,
    type VoiceToolResultRedactionPrefs,
} from '@/voice/context/redactVoiceToolResult';

/**
 * Provider-bound redaction for the REALTIME tool channel.
 *
 * Realtime client tool handlers return a JSON string straight to the provider
 * (the realtime equivalent of the local follow-up `VOICE_TOOL_RESULTS_JSON`
 * channel). Without this wrapper those raw results — which can carry session
 * `title` (summary) and `locationLabel` (path) — reach the model even when the
 * canonical voice privacy prefs disable summary/path sharing.
 *
 * This routes every realtime tool result through the SAME canonical
 * {@link redactVoiceToolResultValue} chokepoint used by the local path, so the
 * realtime path is gated identically. It only CALLS the redaction owner; the
 * gating policy lives in `@/voice/context/redactVoiceToolResult`.
 *
 * Provider-agnostic at the policy layer: prefs are read from the canonical voice
 * privacy settings, not from any ElevenLabs-specific source.
 */
export type RealtimeClientToolHandler = (parameters: unknown) => Promise<string>;
export type RealtimeClientToolMap = Record<string, RealtimeClientToolHandler>;

function resolveRealtimeRedactionPrefs(): VoiceToolResultRedactionPrefs {
    const privacy = readVoicePrivacySettings((storage.getState() as { settings?: unknown })?.settings);
    return {
        shareFilePaths: privacy.shareFilePaths,
        shareSessionSummary: privacy.shareSessionSummary,
        sharePermissionRequests: privacy.sharePermissionRequests,
    };
}

/**
 * Redact a single realtime tool-result string. The handler contract is a JSON
 * string; parse it, redact the value through the canonical owner, and
 * re-serialize. A non-JSON result is treated as an opaque scalar and redacted as
 * a plain value (so path-like strings are still gated). A redaction failure must
 * never crash the tool call: on any error the result is dropped to an empty
 * object so nothing un-redacted leaks to the provider.
 */
export function redactRealtimeClientToolResultString(
    rawResult: string,
    prefs: VoiceToolResultRedactionPrefs = resolveRealtimeRedactionPrefs(),
): string {
    try {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawResult);
        } catch {
            // Not JSON: redact as an opaque scalar string (path-like data still gated).
            const redactedScalar = redactVoiceToolResultValue(rawResult, prefs);
            return typeof redactedScalar === 'string' ? redactedScalar : JSON.stringify(redactedScalar);
        }
        return JSON.stringify(redactVoiceToolResultValue(parsed, prefs));
    } catch {
        // Fail closed: never forward an un-redacted result if redaction itself fails.
        return JSON.stringify({});
    }
}

/**
 * Wrap a realtime client-tool map so every handler's result is routed through
 * the canonical provider-bound redaction before it reaches the provider. Prefs
 * are resolved per-invocation so a settings change between tool calls is honored.
 */
export function redactRealtimeClientToolResults(
    clientTools: RealtimeClientToolMap,
    resolvePrefs: () => VoiceToolResultRedactionPrefs = resolveRealtimeRedactionPrefs,
): RealtimeClientToolMap {
    const wrapped: RealtimeClientToolMap = {};
    for (const [toolName, handler] of Object.entries(clientTools)) {
        wrapped[toolName] = async (parameters: unknown): Promise<string> => {
            const rawResult = await handler(parameters);
            return redactRealtimeClientToolResultString(rawResult, resolvePrefs());
        };
    }
    return wrapped;
}
