import { describe, expect, it } from 'vitest';
import { PLUGIN_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol';

import {
    startEntrySession,
    resumeEntrySessionStart,
    type TriageEntrySessionDepsV1,
} from './entrySessionOrchestrator.js';
import type { TriageSessionActionInvokerV1 } from './entrySessionOpen.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTestkitEntrySessionLinkWriter, TESTKIT_SPAWN_REQUEST } from './testkit/entrySessionTestkit.test-support.js';

/**
 * The Account Collection and generic Session Actions are the two real process
 * boundaries this owner crosses. The canonical Collection testkit keeps link
 * identity, relation queries and persistence real beneath that boundary.
 */
function ownerBoundary() {
    const calls: string[] = [];
    const openInputs: unknown[] = [];
    const execute = (async (actionId: string, input: Readonly<{ initialInput?: unknown }>) => {
        calls.push(actionId);
        if (actionId === 'session.spawn_new') {
            return {
                type: 'success',
                disposition: 'created',
                sessionId: 'session-a',
                executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: input.initialInput === undefined
                    ? { status: 'notRequested' }
                    : { status: 'accepted', localId: 'local-a' },
            };
        }
        if (actionId === 'session.message.send') return { status: 'accepted', localId: 'local-a' };
        if (actionId === 'session.open') {
            openInputs.push(PLUGIN_ACTION_INPUT_SCHEMAS['session.open'].parse(input));
            return null;
        }
        throw new Error(`unexpected generic action: ${actionId}`);
    }) as unknown as TriageSessionActionInvokerV1;
    const { collections } = createTestkitCorpusCollections();
    return {
        calls,
        openInputs,
        deps: {
            linkSession: createTestkitEntrySessionLinkWriter(collections),
            execute,
        } satisfies TriageEntrySessionDepsV1,
    };
}

describe('entry Session final-open ownership', () => {
    it.each(['start', 'retry'] as const)('opens the exact accepted Home after %s through the canonical navigation schema', async (phase) => {
        const boundary = ownerBoundary();
        const result = phase === 'start'
            ? await startEntrySession(boundary.deps, {
                workspaceMode: 'reference_only', destination: {
                    kind: 'new', creationKey: 'creation-key-exact-home', spawn: TESTKIT_SPAWN_REQUEST,
                    materialization: { kind: 'referenceOnly', directory: '/projects/example' },
                },
            })
            : await resumeEntrySessionStart(boundary.deps, {
                pending: { type: 'openPending', sessionId: 'session-a', disposition: 'created', workspace: { kind: 'referenceOnly' } },
                serverId: 'server-a',
            });
        expect(result.type).toBe('opened');
        expect(boundary.openInputs).toEqual([{ sessionId: 'session-a', serverId: 'server-a' }]);
    });

    it.each(['deferred', 'suppressed'] as const)('keeps final navigation %s after retrying uncertain input on the known Session', async (finalOpen) => {
        const boundary = ownerBoundary();
        const result = await resumeEntrySessionStart(boundary.deps, {
            pending: { type: 'openPending', sessionId: 'session-a', disposition: 'created', workspace: { kind: 'referenceOnly' } },
            serverId: 'server-a',
            delivery: { text: 'Repair the failing parser test.', attachments: [], idempotencyKey: 'delivery-key-a' },
            finalOpen,
        });

        expect(result).toEqual({ type: 'linked', sessionId: 'session-a', disposition: 'created',
            workspace: { kind: 'referenceOnly' }, delivery: 'accepted', finalOpen });
        expect(boundary.calls).toEqual(['session.message.send']);
    });

    it('retains final navigation after linking and delivery when a batch explicitly owns it', async () => {
        const boundary = ownerBoundary();

        const result = await startEntrySession(boundary.deps, {
            entryRef: {
                source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '17',
            },
            display: {
                locator: {
                    v: 1,
                    webUrl: 'https://example.test/example/repository/pull/17',
                    displayPath: 'example/repository #17',
                },
                scopeLabel: 'example/repository',
            },
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-retained-open',
                spawn: {
                    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.claude', localId: 'claude' },
                    },
                },
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
            delivery: {
                text: 'Repair the failing parser test.',
                attachments: [],
                idempotencyKey: 'delivery-key-a',
            },
            finalOpen: 'deferred',
        });

        expect(result).toEqual({
            type: 'linked',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
            delivery: 'accepted',
            finalOpen: 'deferred',
        });
        expect(boundary.calls).toEqual([
            'session.spawn_new',
            'session.message.send',
        ]);
    });
});
