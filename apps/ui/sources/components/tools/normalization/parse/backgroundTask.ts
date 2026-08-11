import { maybeParseJson } from './parseJson';

/**
 * The join key between a detached `Bash` command and the background task that outlives it.
 *
 * The Claude Agent SDK's `BashOutput` — the **result** shape of the `Bash` tool, not a tool of its
 * own — carries `backgroundTaskId` whenever the provider detached the command
 * (`@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`). It is the only attestation that detaching
 * actually happened: `BashInput.run_in_background` is a request the provider may decline, so a
 * renderer that trusted the input would claim a background task that does not exist.
 *
 * Three envelopes reach the client and all are real:
 * - the transcript normalizer JSON-**encodes** the raw `toolUseResult` object
 *   (`sync/typesRaw/normalize.ts` → `toolResultContentToText`), and the reducer stores that string
 *   verbatim as `tool.result` — so on the ordinary Claude path the id arrives inside a string;
 * - the SDK log converter nests the same object under `tool_use_result`
 *   (`apps/cli/src/backends/claude/utils/sdkToLogConverter.ts`);
 * - some raw rows carry the camel-cased `toolUseResult` instead.
 *
 * This is the one reader for that key. `apps/cli`'s `claudeRemoteSubagentFileCollector` answers a
 * different question (which provider task ids might own a *sidechain*) and stays separate.
 */
export function readBashBackgroundTaskId(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    const record = asRecord(parsed);
    if (!record) return null;

    return readTaskId(record)
        ?? readTaskId(asRecord(maybeParseJson(record.tool_use_result)))
        ?? readTaskId(asRecord(maybeParseJson(record.toolUseResult)));
}

function readTaskId(record: Record<string, unknown> | null): string | null {
    if (!record) return null;
    return firstNonEmptyString(record.backgroundTaskId) ?? firstNonEmptyString(record.background_task_id);
}

function firstNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
