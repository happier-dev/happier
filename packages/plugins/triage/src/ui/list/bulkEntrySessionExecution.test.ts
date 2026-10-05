import { describe, expect, it } from 'vitest';

import { startTriageEntrySession } from '../../actions/entrySession.js';
import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionInputV1Schema,
    type TriageStartEntrySessionInputV1,
} from '../../actions/entrySessionProtocol.js';
import type { TriageSessionActionInvokerV1 } from '../../sessions/entrySessionOpen.js';
import type { TriageActionV1 } from '../../settings/actions.js';
import type { TriageBulkSelectedEntryV1 } from './bulkSelectionEntries.js';
import type { TriageBulkSessionUnitV1 } from './bulkSessionPlan.js';
import {
    runTriageBulkEntrySessionStartsV1,
    type TriageBulkSessionExecutionHostV1,
} from './bulkEntrySessionExecution.js';

const SETTLEMENT = Object.freeze({
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.claude', localId: 'claude' },
    },
    directory: { kind: 'path' as const, path: '/workspaces/example' },
});

function selectedEntry(entryId: string): TriageBulkSelectedEntryV1 {
    const entryRef = Object.freeze({
        source: { pluginId: 'happier.example.source', localId: 'example-forge' },
        kindId: 'pull-request',
        collisionScope: 'example/repository',
        entryId,
    });
    return Object.freeze({
        key: `entry:${entryId}`,
        entryRef,
        display: {
            locator: {
                v: 1,
                webUrl: `https://example.test/example/repository/pull/${entryId}`,
                displayPath: `example/repository #${entryId}`,
            },
            scopeLabel: 'example/repository',
        },
        sourceInstance: {
            source: entryRef.source,
            sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        },
        presentation: { label: `Entry ${entryId}`, description: 'example/repository' },
        lastKnownLocator: {
            v: 1,
            webUrl: `https://example.test/example/repository/pull/${entryId}`,
            displayPath: `example/repository #${entryId}`,
        },
    });
}

function action(delivery: 'compose' | 'send'): TriageActionV1 {
    return Object.freeze({
        actionId: `bulk-${delivery}`,
        label: `Bulk ${delivery}`,
        enabled: true,
        appliesTo: ['pullRequest'],
        profileId: null,
        workspaceMode: 'reference_only',
        target: { kind: 'agent', promptInvocationId: null, delivery },
    });
}

function unit(
    creationKey: string,
    entries: readonly TriageBulkSelectedEntryV1[],
): TriageBulkSessionUnitV1<TriageBulkSelectedEntryV1> {
    return Object.freeze({ creationKey, entries });
}

/**
 * Generic Session Actions and the Account Collection are process boundaries.
 * The Triage start Action, link Action, delivery and lifecycle owner run for
 * real. Opening deliberately retires this host, proving a later local step
 * cannot be relied on after navigation.
 */
function executionHarness(input: Readonly<{
    spawnSessionIds: readonly string[];
    sendResults?: readonly ('accepted' | 'rejected')[];
    failLinkAttempt?: number;
}>) {
    const lifecycle: string[] = [];
    const startInputs: TriageStartEntrySessionInputV1[] = [];
    const sessions = [...input.spawnSessionIds];
    const sends = [...(input.sendResults ?? [])];
    let linkAttempt = 0;
    let retired = false;
    const sessionLinks = {
        identityTag: async (request: Readonly<{ field: string; components: readonly string[] }>) => (
            `${request.field}:${request.components.join(':')}`
        ),
        get: async () => null,
        batch: async () => {
            linkAttempt += 1;
            lifecycle.push('link');
            if (linkAttempt === input.failLinkAttempt) {
                throw new Error('triage:test:linkUnavailable');
            }
            return { status: 'updated' as const, results: [], changeCursor: 1 };
        },
    };
    const execute = (async (actionId: string, actionInput: Readonly<{ initialInput?: unknown }>) => {
        if (retired) throw new Error('triage:test:mountRetired');
        if (actionId === 'session.spawn_new') {
            lifecycle.push('spawn');
            const sessionId = sessions.shift();
            if (sessionId === undefined) throw new Error('triage:test:missingSpawn');
            return {
                type: 'success',
                disposition: 'created',
                sessionId,
                executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'notRequested' },
            };
        }
        if (actionId === 'session.message.send') {
            lifecycle.push('send');
            return sends.shift() === 'rejected'
                ? { status: 'rejected', code: 'session_input_archived' }
                : { status: 'accepted', localId: 'local-a' };
        }
        if (actionId === 'session.open') {
            lifecycle.push('open');
            retired = true;
            return null;
        }
        throw new Error(`triage:test:unexpectedGenericAction:${actionId}`);
    }) as unknown as TriageSessionActionInvokerV1;
    const host = {
        executeAction: async (actionId: string, actionInput: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
            if (retired) throw new Error('triage:test:mountRetired');
            if (actionId === TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) {
                startInputs.push(TriageStartEntrySessionInputV1Schema.parse(actionInput));
                return await startTriageEntrySession(
                    TriageStartEntrySessionInputV1Schema.parse(actionInput),
                    {
                        collections: { sessionLinks: sessionLinks as never },
                        execute,
                        nowMs: () => 1_760_000_900_000,
                    },
                );
            }
            if (actionId === 'session.open') {
                return await execute('session.open' as never, actionInput as never, options);
            }
            throw new Error(`triage:test:unexpectedAction:${actionId}`);
        },
    } as unknown as TriageBulkSessionExecutionHostV1;
    return {
        host,
        lifecycle,
        startInputs,
        get retired() { return retired; },
    };
}

describe('bulk Session execution lifecycle', () => {
    it('refuses an attachment-only direct start before creating a Session', async () => {
        const harness = executionHarness({ spawnSessionIds: ['must-not-start'] });

        await expect(runTriageBulkEntrySessionStartsV1({
            host: harness.host,
            units: [unit('bulk-empty', [selectedEntry('17')])],
            action: action('compose'),
            destination: 'oneSessionPerEntry',
            promptText: null,
            settlement: SETTLEMENT,
            signal: new AbortController().signal,
        })).rejects.toThrow('triage:bulk:instructionRequired');

        expect(harness.lifecycle).toEqual([]);
        expect(harness.startInputs).toEqual([]);
    });

    it('runs a compose-default action as structured send when the reader picked a direct destination', async () => {
        const first = selectedEntry('17');
        const second = selectedEntry('18');
        const harness = executionHarness({ spawnSessionIds: ['session-all'] });

        const results = await runTriageBulkEntrySessionStartsV1({
            host: harness.host,
            units: [unit('bulk-all', [first, second])],
            action: action('compose'),
            destination: 'oneSessionForAllEntries',
            promptText: 'Compare both entries.',
            settlement: SETTLEMENT,
            signal: new AbortController().signal,
        });

        expect(harness.startInputs).toEqual([
            expect.objectContaining({
                delivery: expect.objectContaining({
                    kind: 'send',
                    text: 'Compare both entries.',
                    attachments: [
                        expect.objectContaining({ entryRef: expect.objectContaining({ entryId: '17' }) }),
                        expect.objectContaining({ entryRef: expect.objectContaining({ entryId: '18' }) }),
                    ],
                }),
            }),
        ]);
        expect(harness.lifecycle).toEqual(['spawn', 'link', 'link', 'send', 'open']);
        expect(results).toEqual([
            expect.objectContaining({
                status: 'settled',
                outcome: expect.objectContaining({
                    entries: [
                        expect.objectContaining({ directSend: 'applied' }),
                        expect.objectContaining({ directSend: 'applied' }),
                    ],
                }),
            }),
        ]);
        expect(harness.retired).toBe(true);
    });

    it('does not admit or open when any required secondary link fails', async () => {
        const first = selectedEntry('17');
        const second = selectedEntry('18');
        const harness = executionHarness({
            spawnSessionIds: ['session-all'],
            failLinkAttempt: 2,
        });

        const results = await runTriageBulkEntrySessionStartsV1({
            host: harness.host,
            units: [unit('bulk-all', [first, second])],
            action: action('send'),
            destination: 'oneSessionForAllEntries',
            promptText: 'Compare both entries.',
            settlement: SETTLEMENT,
            signal: new AbortController().signal,
        });

        expect(harness.lifecycle).toEqual(['spawn', 'link', 'link']);
        expect(results[0]).toMatchObject({
            status: 'settled',
            outcome: {
                start: { type: 'linkPending', sessionId: 'session-all' },
                entries: [
                    { directSend: 'notRequested' },
                    { directSend: 'notRequested' },
                ],
            },
        });
        expect(harness.retired).toBe(false);
    });

    it('settles each one-per-entry unit without choosing a navigation winner, including a refused send', async () => {
        const first = selectedEntry('17');
        const second = selectedEntry('18');
        const harness = executionHarness({
            spawnSessionIds: ['session-17', 'session-18'],
            sendResults: ['accepted', 'rejected'],
        });

        const results = await runTriageBulkEntrySessionStartsV1({
            host: harness.host,
            units: [unit('bulk-17', [first]), unit('bulk-18', [second])],
            action: action('send'),
            destination: 'oneSessionPerEntry',
            promptText: 'Start work.',
            settlement: SETTLEMENT,
            signal: new AbortController().signal,
        });

        expect(harness.lifecycle.filter((step) => step === 'spawn')).toEqual(['spawn', 'spawn']);
        expect(results).toEqual([
            expect.objectContaining({
                status: 'settled',
                outcome: expect.objectContaining({
                    start: expect.objectContaining({ type: 'linked', finalOpen: 'suppressed' }),
                    entries: [expect.objectContaining({ directSend: 'applied' })],
                }),
            }),
            expect.objectContaining({
                status: 'settled',
                outcome: expect.objectContaining({
                    start: expect.objectContaining({ type: 'linked', finalOpen: 'suppressed' }),
                    entries: [expect.objectContaining({ directSend: 'refused' })],
                }),
            }),
        ]);
        expect(harness.retired).toBe(false);
    });

    it('retries a pending phase through the incumbent resume arm', async () => {
        const entry = selectedEntry('17');
        const submitted: TriageStartEntrySessionInputV1[] = [];
        const host = {
            executeAction: async (actionId: string, actionInput: unknown) => {
                if (actionId !== TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) {
                    throw new Error(`triage:test:unexpectedAction:${actionId}`);
                }
                const parsed = TriageStartEntrySessionInputV1Schema.parse(actionInput);
                submitted.push(parsed);
                return {
                    v: 1,
                    type: 'openPending',
                    sessionId: 'session-17',
                    disposition: 'created',
                    delivery: 'accepted',
                };
            },
        } as unknown as TriageBulkSessionExecutionHostV1;
        const units = [unit('bulk-17', [entry])];
        const initial = await runTriageBulkEntrySessionStartsV1({
            host,
            units,
            action: action('send'),
            destination: 'oneSessionPerEntry',
            promptText: 'Start work.',
            settlement: SETTLEMENT,
            signal: new AbortController().signal,
        });

        await runTriageBulkEntrySessionStartsV1({
            host,
            units,
            action: action('send'),
            destination: 'oneSessionPerEntry',
            promptText: 'Start work.',
            settlement: SETTLEMENT,
            signal: new AbortController().signal,
            previousResults: initial,
        });

        expect(submitted[1]?.resume).toEqual({
            phase: 'openPending',
            sessionId: 'session-17',
            disposition: 'created',
            delivery: 'accepted',
        });
    });

    it('retries an unknown send from the existing Session instead of re-entering creation', async () => {
        const entry = selectedEntry('17');
        const units = [unit('bulk-17', [entry])];
        const submitted: TriageStartEntrySessionInputV1[] = [];
        const host = {
            executeAction: async (actionId: string, actionInput: unknown) => {
                if (actionId !== TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) {
                    throw new Error(`triage:test:unexpectedAction:${actionId}`);
                }
                submitted.push(TriageStartEntrySessionInputV1Schema.parse(actionInput));
                return {
                    v: 1,
                    type: 'linked',
                    sessionId: 'session-17',
                    disposition: 'created',
                    delivery: 'accepted',
                    finalOpen: 'suppressed',
                };
            },
        } as unknown as TriageBulkSessionExecutionHostV1;
        const previous = (start: Readonly<{
            v: 1;
            type: 'opened' | 'linked' | 'openPending';
            sessionId: string;
            disposition: 'created';
            delivery: 'outcomeUnknown';
            finalOpen?: 'suppressed';
        }>) => [{
            unit: units[0]!,
            status: 'settled' as const,
            outcome: { start, entries: [] },
        }];

        for (const start of [{
            v: 1 as const,
            type: 'openPending' as const,
            sessionId: 'session-17',
            disposition: 'created' as const,
            delivery: 'outcomeUnknown' as const,
        }, {
            v: 1 as const,
            type: 'opened' as const,
            sessionId: 'session-17',
            disposition: 'created' as const,
            delivery: 'outcomeUnknown' as const,
        }, {
            v: 1 as const,
            type: 'linked' as const,
            sessionId: 'session-17',
            disposition: 'created' as const,
            delivery: 'outcomeUnknown' as const,
            finalOpen: 'suppressed' as const,
        }]) {
            await runTriageBulkEntrySessionStartsV1({
                host,
                units,
                action: action('send'),
                destination: 'oneSessionPerEntry',
                promptText: 'Start work.',
                settlement: SETTLEMENT,
                signal: new AbortController().signal,
                previousResults: previous(start),
            });
        }

        expect(submitted.map((input) => input.resume)).toEqual([{
            phase: 'openPending',
            sessionId: 'session-17',
            disposition: 'created',
        }, {
            phase: 'openPending',
            sessionId: 'session-17',
            disposition: 'created',
        }, {
            phase: 'linkPending',
            sessionId: 'session-17',
            disposition: 'created',
        }]);
    });
});
