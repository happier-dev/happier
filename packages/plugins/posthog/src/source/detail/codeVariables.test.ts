import { describe, expect, it } from 'vitest';

import issueEventsPage from '../../api/__fixtures__/queryIssueEventsPage.json' with { type: 'json' };
import { createPosthogApiClient, type PosthogTransportRequest } from '../../api/client.js';
import { normalizePosthogApiOrigin } from '../../connect/origin.js';
import { readPosthogCodeVariables } from './codeVariables.js';

const resolvedOrigin = normalizePosthogApiOrigin('https://eu.posthog.com');
if (!resolvedOrigin.ok) throw new Error('fixture origin must normalize');

function setup(response: unknown) {
    const calls: Readonly<{ url: string; request: PosthogTransportRequest }>[] = [];
    const client = createPosthogApiClient({
        origin: resolvedOrigin.origin,
        materializeHeaders: async () => ({ ok: true, authorization: 'Bearer fixture' }),
        transport: async (url, request) => {
            calls.push({ url, request });
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });
    return { client, calls };
}

describe('readPosthogCodeVariables', () => {
    it('rereads exactly one selected offset with only the explicit sensitive include', async () => {
        const selected = {
            ...issueEventsPage.results[1],
            properties: {
                sibling_must_not_survive: 'secret-adjacent',
                $exception_code_variables: { obsolete_shape_must_not_survive: true },
                $exception_list: [{
                    type: 'TypeError',
                    sibling_must_not_survive: 'exception',
                    stacktrace: {
                        frames: [{
                            function: 'renderSummary',
                            source: 'app/checkout/summary.tsx',
                            line: 128,
                            column: 17,
                            sibling_must_not_survive: 'frame',
                            code_variables: { order: 'captured-value' },
                        }],
                    },
                }],
            },
        };
        const { client, calls } = setup({
            ...issueEventsPage,
            results: [selected],
            limit: 1,
            offset: 1,
            hasMore: false,
            nextOffset: null,
        });

        const result = await readPosthogCodeVariables(client, {
            teamRouteId: 4821,
            issueId: '00000000-0000-4000-8000-000000000001',
            detailWindow: {
                from: '2026-07-16T00:00:00.000Z',
                to: '2026-08-15T00:00:00.000Z',
            },
            selectedUuid: selected.uuid,
            selectedOffset: 1,
        }, {});

        expect(result).toEqual({
            ok: true,
            value: {
                variables: [{
                    frame: {
                        function: 'renderSummary',
                        source: 'app/checkout/summary.tsx',
                        line: 128,
                        column: 17,
                    },
                    variables: { order: 'captured-value' },
                }],
            },
        });
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0]?.request.body ?? '{}')).toEqual({
            issueId: '00000000-0000-4000-8000-000000000001',
            dateRange: {
                date_from: '2026-07-16T00:00:00.000Z',
                date_to: '2026-08-15T00:00:00.000Z',
            },
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['code_variables'],
            limit: 1,
            offset: 1,
        });
    });

    it('publishes no variable when the frozen offset now names a different occurrence', async () => {
        const { client } = setup({
            ...issueEventsPage,
            results: [issueEventsPage.results[0]],
            limit: 1,
            offset: 1,
            hasMore: false,
            nextOffset: null,
        });

        const result = await readPosthogCodeVariables(client, {
            teamRouteId: 4821,
            issueId: '00000000-0000-4000-8000-000000000001',
            detailWindow: { from: '2026-07-16T00:00:00.000Z', to: null },
            selectedUuid: issueEventsPage.results[1]?.uuid ?? '',
            selectedOffset: 1,
        }, {});

        expect(result).toEqual({
            ok: false,
            failure: { kind: 'malformedResponse', at: 'selectedEvent' },
        });
    });
});
