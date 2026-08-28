/** One warning-confirmed, exact-occurrence PostHog code-variable reread. */

import type { PosthogApiClient, PosthogRequestOptions, PosthogResult } from '../../api/client.js';
import { errorTrackingIssueEventsQueryPath, resolvePosthogTeamRouteId } from '../../api/paths.js';
import { parsePosthogIssueEventsEnvelope } from '../../api/types/events.js';
import type { PosthogResolvedWindow } from '../scan/request.js';

export const POSTHOG_CODE_VARIABLES_INCLUDE = ['code_variables'] as const;

export type PosthogCodeVariablesReadInput = Readonly<{
    teamRouteId: number;
    issueId: string;
    detailWindow: PosthogResolvedWindow;
    selectedUuid: string;
    selectedOffset: number;
}>;

export type PosthogCodeVariablesRead = Readonly<{
    variables: unknown;
}>;

function object(value: unknown): Readonly<Record<string, unknown>> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

/**
 * Copies only the frame coordinates and the explicitly requested variable payload.
 * Current PostHog nests captured variables on exception stack frames; every sibling in
 * the open event-properties bag is dropped before the Action result is constructed.
 */
export function projectPosthogCodeVariables(
    properties: Readonly<Record<string, unknown>>,
): unknown {
    const projected: unknown[] = [];
    const exceptions = properties['$exception_list'];
    if (!Array.isArray(exceptions)) return projected;
    for (const exceptionValue of exceptions) {
        const exception = object(exceptionValue);
        const stacktrace = object(exception?.['stacktrace']);
        const frames = stacktrace?.['frames'];
        if (!Array.isArray(frames)) continue;
        for (const frameValue of frames) {
            const frame = object(frameValue);
            if (frame === null || !Object.hasOwn(frame, 'code_variables')) continue;
            const fn = typeof frame['function'] === 'string' ? frame['function'] : null;
            const source = typeof frame['source'] === 'string' ? frame['source'] : null;
            const line = typeof frame['line'] === 'number' && Number.isSafeInteger(frame['line'])
                ? frame['line']
                : null;
            const column = typeof frame['column'] === 'number' && Number.isSafeInteger(frame['column'])
                ? frame['column']
                : null;
            projected.push({
                frame: {
                    ...(fn === null ? {} : { function: fn }),
                    ...(source === null ? {} : { source }),
                    ...(line === null ? {} : { line }),
                    ...(column === null ? {} : { column }),
                },
                variables: frame['code_variables'],
            });
        }
    }
    return projected;
}

export async function readPosthogCodeVariables(
    client: PosthogApiClient,
    input: PosthogCodeVariablesReadInput,
    options: PosthogRequestOptions,
): Promise<PosthogResult<PosthogCodeVariablesRead>> {
    const route = resolvePosthogTeamRouteId(input.teamRouteId);
    if (!route.ok) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'teamRouteId' } };
    }
    if (!Number.isSafeInteger(input.selectedOffset) || input.selectedOffset < 0) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'selectedOffset' } };
    }
    const page = await client.requestJson({
        method: 'POST',
        path: errorTrackingIssueEventsQueryPath(route.teamRouteId),
        body: {
            issueId: input.issueId,
            dateRange: {
                date_from: input.detailWindow.from,
                date_to: input.detailWindow.to,
            },
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: POSTHOG_CODE_VARIABLES_INCLUDE,
            limit: 1,
            offset: input.selectedOffset,
        },
    }, parsePosthogIssueEventsEnvelope, options);
    if (!page.ok) return page;
    if (page.value.skippedRowCount !== 0 || page.value.rawEvents.length !== 1) {
        return { ok: false, failure: { kind: 'malformedResponse', at: 'selectedEvent' } };
    }
    const event = page.value.rawEvents[0];
    if (event === undefined || event.uuid !== input.selectedUuid) {
        return { ok: false, failure: { kind: 'malformedResponse', at: 'selectedEvent' } };
    }
    return {
        ok: true,
        value: { variables: projectPosthogCodeVariables(event.rawProperties) },
    };
}
