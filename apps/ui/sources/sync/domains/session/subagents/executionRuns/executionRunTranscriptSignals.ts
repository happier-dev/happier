import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import {
    readExecutionRunIdFromToolPayload,
    toolNameLooksLikeExecutionRunStop,
} from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';

/**
 * The text-shaped transcript signals the execution-run derivation still reads — all of them, in one
 * place, so the retention is visible rather than scattered.
 *
 * The regex/recursive *status* scrape is gone: a run's status now comes from the structured payload
 * alone (`executionRunSubagentStatus.ts`), because a subagent's own prose could otherwise set the
 * status the roster displayed and the composer routed to. These readers survive that ruling
 * deliberately, and the distinction is exact:
 *
 * - **None of them can set a status.** They answer two narrower questions — "did an explicit stop
 *   call succeed?" and "did the agent announce a run it has no tool call for?" — and both answers
 *   are then subordinated to structured evidence by `deriveExecutionRunSubagents`.
 * - **Their inputs are genuinely text.** A stop tool returns an MCP result whose payload is a
 *   stringified envelope, and an agent's start announcement is prose by definition. There is no
 *   structured field to read instead; the alternative is not reading them at all.
 *
 * If a structured stop result or a typed run-start event ever lands, these become deletable.
 */

export function valueHasOkTrueSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"');
        return /"ok"\s*:\s*true/i.test(normalized) || /\bok\s*:\s*true\b/i.test(normalized);
    }

    if (Array.isArray(value)) {
        return value.some((item) => valueHasOkTrueSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.ok === true) return true;
        return Object.values(record).some((item) => valueHasOkTrueSignal(item, depth + 1));
    }

    return false;
}

export function valueHasExecutionRunNotRunningSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"');
        return (
            /\berrorCode\s*:\s*"?execution_run_not_allowed"?/i.test(normalized)
            || /\berrorCode\s*:\s*"?execution_run_not_running"?/i.test(normalized)
            || /\bnot running\b/i.test(normalized)
            || /\balready finished\b/i.test(normalized)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => valueHasExecutionRunNotRunningSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const errorCode = typeof record.errorCode === 'string' ? String(record.errorCode).trim().toLowerCase() : '';
        if (errorCode === 'execution_run_not_allowed' || errorCode === 'execution_run_not_running') return true;

        const error = typeof record.error === 'string' ? String(record.error).trim().toLowerCase() : '';
        if (error.includes('not running') || error.includes('already finished')) return true;

        return Object.values(record).some((item) => valueHasExecutionRunNotRunningSignal(item, depth + 1));
    }

    return false;
}

export function looksLikeExecutionRunStartText(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
        normalized.includes('execution run has been started')
        || normalized.includes('execution run started')
        || normalized.includes('run has been started')
        || normalized.includes('new long-lived execution run started')
        || normalized.includes('bounded execution run started')
    );
}

/**
 * Run ids named in an agent's own announcement.
 *
 * Deliberately NOT called `extractExecutionRunIdsFromText`: `participants/
 * deriveExecutionRunPollingRefreshKey.ts` already exports a function of that exact name, and the
 * two accept different charsets (`[0-9a-f-]` there, `[0-9a-z-]` here). The distinct name is so a
 * reader who greps finds one definition per behaviour instead of two that look interchangeable.
 */
export function extractExecutionRunIdsFromAgentText(text: string): readonly string[] {
    const directMatches = text.match(/run_[0-9a-z-]{8,}/gi) ?? [];
    return Array.from(new Set(directMatches.map((value) => value.trim())));
}

export function deriveExplicitlyStoppedExecutionRunIds(messages: readonly Message[]): ReadonlySet<string> {
    const stoppedRunIds = new Set<string>();
    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        if (!toolMessage.tool || toolMessage.tool.state !== 'completed') continue;
        if (!toolNameLooksLikeExecutionRunStop(toolMessage.tool.name)) continue;

        const runId = readExecutionRunIdFromToolPayload(toolMessage.tool);
        if (!runId) continue;
        if (!valueHasOkTrueSignal(toolMessage.tool.result) && !valueHasExecutionRunNotRunningSignal(toolMessage.tool.result)) continue;
        stoppedRunIds.add(runId);
    }
    return stoppedRunIds;
}
