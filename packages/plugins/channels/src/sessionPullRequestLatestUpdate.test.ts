import { describe, expect, it } from 'vitest';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { readSessionPullRequestLatestUpdateForBinding } from './sessionPullRequestLatestUpdate.js';

describe('lightweight retained PR latest update', () => {
    it.each([true, false])('preserves only the selected provider event resource intent (recognized=%s)', async recognized => {
        const state = new MemoryCollection();
        const resource = { kind: 'ciRun', url: 'https://forge.example/acme/widgets/actions/runs/42' } as const;
        const url = recognized ? resource.url : 'https://third-party.example/build/42';
        const event = { revision: '1', occurredAt: 20, author: { principalId: null, kind: 'process' } };
        await state.put({ id: 'leader-resource', 'record-kind': 'ingress-obligation', 'session-id': 'session-1',
            'binding-id': 'binding-1', 'pr-update-at': 20, payload: { occurrenceIds: ['native-cycle-1'],
                prUpdate: { v: 1, bindingId: 'binding-1', sessionId: 'session-1',
                    pullRequest: { repository: 'acme/widgets', number: 12 }, head: { sha: 'head-sha', ref: 'feature' },
                    events: [
                        { ...event, id: 'prior', kind: 'comment', body: 'Earlier update',
                            url: 'https://forge.example/acme/widgets/pull/12',
                            resource: { kind: 'pullRequest', url: 'https://forge.example/acme/widgets/pull/12' } },
                        { ...event, id: 'check', kind: 'check', logicalCheckId: 'unit', name: 'Tests', state: 'passed',
                            url, ...(recognized ? { resource } : {}) },
                    ] } } }, { expectedRevision: 'absent' });
        const account = { collection: () => state } as unknown as PluginAccountStorageScope;
        const latest = await readSessionPullRequestLatestUpdateForBinding({ sessionId: 'session-1', bindingId: 'binding-1' }, {
            services: { storage: { account } }, signal: new AbortController().signal,
        });
        expect(latest?.location).toEqual({ kind: 'provider', url, ...(recognized ? { resource } : {}) });
    });

    it('summarizes all event counts without forwarding provider bodies and preserves the full retained input destination', async () => {
        const state = new MemoryCollection();
        const event = { id: 'comment-1', revision: '1', occurredAt: 20, author: { principalId: 'author', kind: 'person' } };
        await state.put({ id: 'leader-1', 'record-kind': 'ingress-obligation', 'session-id': 'session-1', 'binding-id': 'binding-1', 'pr-update-at': 20,
            payload: { occurrenceIds: ['native-cycle-1'], sessionInput: { sessionId: 'session-1', localId: 'accepted-input-1' },
                prUpdate: { v: 1, bindingId: 'binding-1', sessionId: 'session-1', pullRequest: { repository: 'acme/widgets', number: 12 },
                    head: { sha: 'head-sha', ref: 'feature' }, events: [
                        { ...event, kind: 'comment', body: `PRIVATE-LONG-BODY${'x'.repeat(100_000)}` },
                        { ...event, id: 'comment-2', kind: 'comment', body: 'SECOND-PRIVATE-BODY' },
                        { ...event, id: 'review-1', kind: 'review', body: 'PRIVATE-REVIEW', verdict: 'changesRequested', inlineCommentIds: [] },
                        { ...event, id: 'check-1', kind: 'check', logicalCheckId: 'unit', name: 'PRIVATE-NATIVE-LABEL', state: 'failed',
                            failure: { kind: 'unavailable', reason: 'PRIVATE-PROVIDER-DETAIL' } },
                    ] } } }, { expectedRevision: 'absent' });
        const account = { collection: (definition: { id: string }) => {
            if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
            return state;
        } } as unknown as PluginAccountStorageScope;
        const latest = await readSessionPullRequestLatestUpdateForBinding({ sessionId: 'session-1', bindingId: 'binding-1' }, {
            services: { storage: { account } }, signal: new AbortController().signal,
        });
        expect(latest?.summary.includes('PRIVATE')).toBe(false);
        expect(latest).toMatchObject({ summary: '2 comments, 1 review, 1 failed check', summaryTruncated: false,
            occurrenceId: 'native-cycle-1', occurredAtMs: 20,
            kinds: ['comment', 'review', 'check'], location: { kind: 'sessionInput', localId: 'accepted-input-1' } });
        expect(JSON.stringify(latest).includes('PRIVATE')).toBe(false);
        expect((await state.get('leader-1'))?.value.payload).toMatchObject({ prUpdate: { events: [{ body: expect.stringContaining('PRIVATE-LONG-BODY') }, {}, {}, {}] } });
    });
});
