import { describe, expect, it } from 'vitest';

import { startTriageEntrySession } from '../../actions/entrySession.js';
import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionInputV1Schema,
} from '../../actions/entrySessionProtocol.js';
import { linkTriageEntryToSession } from '../../actions/sessionLinks.js';
import {
    TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
    TriageLinkEntryToSessionInputV1Schema,
} from '../../actions/sessionLinksProtocol.js';
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
    directory: '/workspaces/example',
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
}>) {
    const lifecycle: string[] = [];
    const composerTransactions: unknown[] = [];
    const sessions = [...input.spawnSessionIds];
    const sends = [...(input.sendResults ?? [])];
    let retired = false;
    const sessionLinks = {
        identityTag: async (request: Readonly<{ field: string; components: readonly string[] }>) => (
            `${request.field}:${request.components.join(':')}`
        ),
        get: async () => null,
        batch: async () => ({ status: 'updated' as const, results: [], changeCursor: 1 }),
    };
    const execute = (async (actionId: string) => {
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
                return await startTriageEntrySession(
                    TriageStartEntrySessionInputV1Schema.parse(actionInput),
                    {
                        collections: { sessionLinks: sessionLinks as never },
                        execute,
                        nowMs: () => 1_760_000_900_000,
                    },
                );
            }
            if (actionId === TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1) {
                lifecycle.push('link');
                return await linkTriageEntryToSession(
                    TriageLinkEntryToSessionInputV1Schema.parse(actionInput),
                    {
                        collections: { sessionLinks: sessionLinks as never },
                        nowMs: () => 1_760_000_900_000,
                    },
                );
            }
            if (actionId === 'session.open') {
                return await execute('session.open' as never, actionInput as never, options);
            }
            throw new Error(`triage:test:unexpectedAction:${actionId}`);
        },
        readComposer: async () => {
            if (retired) throw new Error('triage:test:mountRetired');
            lifecycle.push('composer.read');
            return { status: 'ready', snapshot: { revision: 7 } };
        },
        applyComposer: async (_ref: unknown, transaction: unknown) => {
            if (retired) throw new Error('triage:test:mountRetired');
            lifecycle.push('composer.apply');
            composerTransactions.push(transaction);
            return { status: 'applied' };
        },
    } as unknown as TriageBulkSessionExecutionHostV1;
    return {
        host,
        lifecycle,
        composerTransactions,
        get retired() { return retired; },
    };
}

describe('bulk Session execution lifecycle', () => {
    it('finishes one-for-all links and compose before its one retained generic open', async () => {
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

        expect(harness.lifecycle).toEqual([
            'spawn',
            'link',
            'composer.read',
            'composer.apply',
            'open',
        ]);
        expect(results).toEqual([expect.objectContaining({
            status: 'settled',
            outcome: expect.objectContaining({
                start: expect.objectContaining({ type: 'opened', sessionId: 'session-all' }),
                entries: [
                    expect.objectContaining({ link: 'created', attachment: 'carried' }),
                    expect.objectContaining({ link: 'created', attachment: 'carried' }),
                ],
            }),
        })]);
        expect(harness.retired).toBe(true);
        expect(harness.composerTransactions).toHaveLength(1);
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

        expect(harness.lifecycle).toEqual(['spawn', 'send', 'spawn', 'send']);
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
});
