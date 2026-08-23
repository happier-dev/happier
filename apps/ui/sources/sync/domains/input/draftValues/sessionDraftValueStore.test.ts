import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    type ComposerAttachmentDraftV1,
    MENTION_KIND_V1,
    buildMentionRefForKindV1,
} from '@happier-dev/protocol';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { loadRawSessionDraftValues } from '@/sync/domains/state/sessionDraftValuesPersistence';
import { sessionDraftValuesStorageKey } from '@/sync/domains/state/sessionLocalStateKeys';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';

import {
    SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
    SESSION_DRAFT_VALUE_FIELD_CATALOG,
} from './sessionDraftValueFieldCatalog';
import {
    advanceSessionComposerSemanticRevision,
    batchSessionComposerSemanticRevision,
    clearSessionDraftValue,
    clearSessionDraftValuesForSession,
    flushSessionDraftValues,
    garbageCollectSessionDraftValues,
    invalidateSessionDraftValueCache,
    readSessionComposerSemanticRevision,
    readSessionDraftValue,
    readSessionDraftValueMutationRevision,
    resetSessionDraftValueCachesForTests,
    subscribeSessionComposerSemanticRevision,
    writeSessionDraftValue,
} from './sessionDraftValueStore';

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

const ARMED_CONTINUATION = {
    backendTargetKey: 'backend:codex',
    intent: {
        v: 1,
        mode: 'same_session',
        sourceAgentId: 'claude',
        selection: { v: 1, agentId: 'codex' },
    },
} as const;

describe('session draft value store', () => {
    beforeEach(() => {
        store.clear();
        resetSessionDraftValueCachesForTests();
    });

    it('declares the semantic fields owned by AgentInput drafts', () => {
        expect(Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG).sort()).toEqual([
            'routing.agentContinuation',
            'routing.executionRunDelivery',
            'routing.recipient',
            'structuredInput.composerAttachments',
            'structuredInput.mentions',
        ]);
        expect(SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS).toBe(30);
    });

    it('keeps a submitted localId and exact user-message snapshot inside the arm', () => {
        const armed = {
            ...ARMED_CONTINUATION,
            submission: {
                localId: 'armed-local-1',
                input: {
                    localId: 'armed-local-1',
                    text: 'switch and send this',
                    meta: { displayText: 'Switch and send this' },
                },
            },
        } as never;
        writeSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation', armed, 100);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation')).toEqual(armed);
        garbageCollectSessionDraftValues(scopeA, { now: 100 + 25 * 60 * 60 * 1000 });
        // The submission has the arm's shared draft lifetime; there is no second
        // field and no shorter transition-specific TTL.
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation')).toEqual(armed);
    });

    it('owns one scoped semantic revision for text, references, and attachments', () => {
        const notifications = vi.fn();
        const unsubscribe = subscribeSessionComposerSemanticRevision(scopeA, 'session-1', notifications);

        expect(readSessionComposerSemanticRevision(scopeA, 'session-1')).toBe(0);
        expect(advanceSessionComposerSemanticRevision(scopeA, 'session-1')).toBe(1);

        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', [{
            kind: 'skill',
            name: 'review',
            tokenText: '@review',
        }]);
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt');

        batchSessionComposerSemanticRevision(scopeA, 'session-1', () => {
            writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.composerAttachments', [{
                v: 1,
                instanceId: 'issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            }]);
            clearSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions');
        });

        expect(readSessionComposerSemanticRevision(scopeA, 'session-1')).toBe(3);
        expect(notifications).toHaveBeenCalledTimes(3);
        unsubscribe();
    });

    it('roundtrips registered values through a scoped in-memory cache and raw persistence', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        flushSessionDraftValues(scopeA);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');
        expect(readSessionDraftValue(scopeB, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
        expect(loadRawSessionDraftValues(scopeA)).toEqual({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
            },
        });
    });

    it('roundtrips plugin-qualified composer attachments through the existing semantic draft owner', () => {
        const attachments: readonly ComposerAttachmentDraftV1[] = [{
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        }];

        writeSessionDraftValue(
            scopeA,
            'session-1',
            'structuredInput.composerAttachments',
            attachments,
            100,
        );
        flushSessionDraftValues(scopeA);

        expect(readSessionDraftValue(
            scopeA,
            'session-1',
            'structuredInput.composerAttachments',
        )).toEqual(attachments);
        expect(loadRawSessionDraftValues(scopeA)).toEqual({
            'session-1': {
                'structuredInput.composerAttachments': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: attachments,
                },
            },
        });
    });

    it('distinguishes explicit null recipient from a missing draft value', () => {
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();

        writeSessionDraftValue(scopeA, 'session-1', 'routing.recipient', null, 100);
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeNull();

        clearSessionDraftValue(scopeA, 'session-1', 'routing.recipient');
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();
    });

    it('does not churn persisted values for unchanged writes or missing clears', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        flushSessionDraftValues(scopeA);

        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 200);
        clearSessionDraftValue(scopeA, 'session-1', 'routing.recipient');
        flushSessionDraftValues(scopeA);

        expect(loadRawSessionDraftValues(scopeA)).toEqual({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
            },
        });
    });

    it('advances the in-memory field revision for an explicit clear without persisting a tombstone', () => {
        const before = readSessionDraftValueMutationRevision(
            scopeA,
            'session-1',
            'routing.recipient',
        );

        // A pending-message edit has already cleared this field. A later user
        // clear still has meaning: its predecessor value must not be restored.
        clearSessionDraftValue(scopeA, 'session-1', 'routing.recipient');

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();
        expect(readSessionDraftValueMutationRevision(
            scopeA,
            'session-1',
            'routing.recipient',
        )).toBe(before + 1);
        flushSessionDraftValues(scopeA);
        expect(loadRawSessionDraftValues(scopeA)).toEqual({});
    });

    it('salvages valid persisted fields and drops malformed envelopes without dirtying valid entries', () => {
        store.set(sessionDraftValuesStorageKey(scopeA), JSON.stringify({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
                'routing.recipient': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: { kind: 'missing' },
                },
                'unknown.field': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: true,
                },
            },
        }));

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();

        flushSessionDraftValues(scopeA);
        expect(JSON.parse(store.get(sessionDraftValuesStorageKey(scopeA)) ?? '{}')).toEqual({
            'session-1': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: 'interrupt',
                },
            },
        });
    });

    it('clears values by lifecycle without clearing unrelated fields', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', [], 100);

        clearSessionDraftValuesForSession(scopeA, 'session-1', { reason: 'composerClear' });

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toBeUndefined();
    });

    it('clears routing values at outbound handoff', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.recipient', null, 100);
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        // The armed Agent leaves with the message that consumed it, exactly like
        // the rest of the routing draft it belongs to.
        writeSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation', ARMED_CONTINUATION, 100);

        clearSessionDraftValuesForSession(scopeA, 'session-1', { reason: 'send' });

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation')).toBeUndefined();
    });

    it('clears the armed Agent when a composer action consumes the draft', () => {
        // The armed choice is a composer-routing field, so a composer clear must
        // consume its persisted half alongside the recipient.
        writeSessionDraftValue(scopeA, 'session-1', 'routing.recipient', null, 100);
        writeSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation', ARMED_CONTINUATION, 100);

        clearSessionDraftValuesForSession(scopeA, 'session-1', { reason: 'composerClear' });

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation')).toBeUndefined();
    });

    it('keeps an armed Agent across a reload and refuses a malformed one', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation', ARMED_CONTINUATION, 100);
        flushSessionDraftValues(scopeA);
        invalidateSessionDraftValueCache(scopeA);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation')).toEqual(ARMED_CONTINUATION);

        // An arm with no target row to point at is not a weaker arm, it is an
        // unreadable one: the picker could never re-establish which row it came from.
        writeSessionDraftValue(
            scopeA,
            'session-1',
            'routing.agentContinuation',
            { ...ARMED_CONTINUATION, backendTargetKey: '' } as never,
            200,
        );
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.agentContinuation')).toEqual(ARMED_CONTINUATION);
    });

    it('clears only outbound fields unchanged since the captured semantic snapshot', () => {
        const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
        writeSessionDraftValue(scopeA, 'session-1', 'routing.recipient', recipient, 100);
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);

        const snapshot = {
            values: {
                'routing.recipient': recipient,
                'routing.executionRunDelivery': 'interrupt' as const,
            },
            mutationRevisions: {
                'routing.recipient': readSessionDraftValueMutationRevision(
                    scopeA,
                    'session-1',
                    'routing.recipient',
                ),
                'routing.executionRunDelivery': readSessionDraftValueMutationRevision(
                    scopeA,
                    'session-1',
                    'routing.executionRunDelivery',
                ),
            },
        };

        // The delivery option changed after send capture and must remain the
        // new draft value even though the outbound handoff is accepted.
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'prompt', 200);

        const cleared = clearSessionDraftValuesForSession(scopeA, 'session-1', {
            reason: 'send',
            snapshot,
        });

        expect(cleared).toEqual(['routing.recipient']);
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.recipient')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('prompt');
    });

    it('clears accepted attachment drafts while retaining references changed during the same send', () => {
        const acceptedMentions = [{
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        }];
        const newerMentions = [{
            kind: 'skill' as const,
            tokenText: '$newer',
            name: 'newer',
        }];
        const acceptedAttachments: readonly ComposerAttachmentDraftV1[] = [{
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        }];
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', acceptedMentions, 100);
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.composerAttachments', acceptedAttachments, 100);
        const acceptedMentionSnapshot = readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions');
        const acceptedAttachmentSnapshot = readSessionDraftValue(
            scopeA,
            'session-1',
            'structuredInput.composerAttachments',
        );
        if (!acceptedMentionSnapshot || !acceptedAttachmentSnapshot) {
            throw new Error('expected persisted semantic draft values');
        }
        const snapshot = {
            values: {
                'structuredInput.mentions': acceptedMentionSnapshot,
                'structuredInput.composerAttachments': acceptedAttachmentSnapshot,
            },
            mutationRevisions: {
                'structuredInput.mentions': readSessionDraftValueMutationRevision(
                    scopeA,
                    'session-1',
                    'structuredInput.mentions',
                ),
                'structuredInput.composerAttachments': readSessionDraftValueMutationRevision(
                    scopeA,
                    'session-1',
                    'structuredInput.composerAttachments',
                ),
            },
        };

        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', newerMentions, 200);

        expect(clearSessionDraftValuesForSession(scopeA, 'session-1', {
            reason: 'send',
            snapshot,
        })).toEqual(['structuredInput.composerAttachments']);
        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toEqual(newerMentions);
        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.composerAttachments')).toBeUndefined();
    });

    it('clears accepted references while retaining attachments changed during the same send', () => {
        const acceptedMentions = [{
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        }];
        const acceptedAttachments: readonly ComposerAttachmentDraftV1[] = [{
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        }];
        const newerAttachments: readonly ComposerAttachmentDraftV1[] = [{
            ...acceptedAttachments[0]!,
            value: { issueId: 99 },
            presentation: { label: 'Issue #99', typeLabel: 'Issue' },
        }];
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', acceptedMentions, 100);
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.composerAttachments', acceptedAttachments, 100);
        const acceptedMentionSnapshot = readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions');
        const acceptedAttachmentSnapshot = readSessionDraftValue(
            scopeA,
            'session-1',
            'structuredInput.composerAttachments',
        );
        if (!acceptedMentionSnapshot || !acceptedAttachmentSnapshot) {
            throw new Error('expected persisted semantic draft values');
        }
        const snapshot = {
            values: {
                'structuredInput.mentions': acceptedMentionSnapshot,
                'structuredInput.composerAttachments': acceptedAttachmentSnapshot,
            },
            mutationRevisions: {
                'structuredInput.mentions': readSessionDraftValueMutationRevision(
                    scopeA,
                    'session-1',
                    'structuredInput.mentions',
                ),
                'structuredInput.composerAttachments': readSessionDraftValueMutationRevision(
                    scopeA,
                    'session-1',
                    'structuredInput.composerAttachments',
                ),
            },
        };

        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.composerAttachments', newerAttachments, 200);

        expect(clearSessionDraftValuesForSession(scopeA, 'session-1', {
            reason: 'send',
            snapshot,
        })).toEqual(['structuredInput.mentions']);
        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.composerAttachments')).toEqual(newerAttachments);
    });

    it('garbage-collects stale values according to field TTL metadata', () => {
        const now = 100 + SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000 + 1;
        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', [], 100);
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', now);

        garbageCollectSessionDraftValues(scopeA, { now });

        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toBeUndefined();
        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');
    });

    it('keeps the surviving draft mentions when one persisted element is malformed (D-14)', () => {
        const good = { kind: 'skill' as const, tokenText: '$review', name: 'review' };
        store.set(sessionDraftValuesStorageKey(scopeA), JSON.stringify({
            'session-1': {
                'structuredInput.mentions': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    // The second element has no `name`, so the skill arm rejects it.
                    value: [good, { kind: 'skill', tokenText: '$broken' }],
                },
            },
        }));

        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toEqual([good]);
    });

    it('loads a draft written before mentions dropped their positions', () => {
        // Positions were part of the persisted shape until they stopped gating anything. A
        // draft that still carries them must load, not be discarded as malformed: the known
        // arms are plain objects so zod strips the extra keys, and the unknown arm is
        // passthrough so a newer build's fields still survive this build (INV-4).
        store.set(sessionDraftValuesStorageKey(scopeA), JSON.stringify({
            'session-1': {
                'structuredInput.mentions': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: [
                        { kind: 'skill', tokenText: '$review', start: 0, end: 7, name: 'review' },
                        { kind: 'acme.ticket', tokenText: '@ACME-1', start: 8, end: 15 },
                    ],
                },
            },
        }));

        expect(readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions')).toEqual([
            { kind: 'skill', tokenText: '$review', name: 'review' },
            { kind: 'acme.ticket', tokenText: '@ACME-1', start: 8, end: 15 },
        ]);
    });

    it('sends the same envelope for a skill draft before and after a restart', () => {
        // Exactly what the skill suggestion kind emits (composerSuggestionKinds.ts),
        // plus the token the composer adds when it is placed.
        const skillMention = {
            kind: 'skill' as const,
            tokenText: '$review',
            id: 'vendor:codex:review',
            name: 'review',
            path: '/skills/review/SKILL.md',
            displayName: 'Review',
            description: 'Reviews a diff',
            origin: 'vendor',
            projectionKind: 'codex-native',
            projectionRef: 'codex-native:review',
            backendId: 'codex',
            agentId: 'codex-agent',
        };
        const text = '$review please';

        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', [skillMention], 100);
        flushSessionDraftValues(scopeA);
        // A cold app start rehydrates the cache from raw persistence.
        invalidateSessionDraftValueCache(scopeA);

        const restored = readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions');
        expect(buildStructuredInputMetaOverrides({ mentions: restored ?? [], text }))
            .toEqual(buildStructuredInputMetaOverrides({ mentions: [skillMention], text }));
        expect(buildStructuredInputMetaOverrides({ mentions: restored ?? [], text })).toMatchObject({
            happierStructuredInputV1: {
                mentions: [expect.objectContaining({
                    kind: MENTION_KIND_V1.skill,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review'),
                    token: '$review',
                    label: 'Review',
                })],
                skillMentions: [expect.objectContaining({
                    origin: 'vendor',
                    backendId: 'codex',
                    agentId: 'codex-agent',
                    projectionRef: 'codex-native:review',
                })],
            },
        });
        expect(restored).toEqual([skillMention]);
    });

    it('preserves a mention of an unknown kind through load, re-save and read (INV-4)', () => {
        const unknown = {
            kind: 'happier.session',
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'abc'),
            label: 'Session abc',
            tokenText: '@session:abc',
        };
        store.set(sessionDraftValuesStorageKey(scopeA), JSON.stringify({
            'session-1': {
                'structuredInput.mentions': {
                    v: 1,
                    updatedAt: 100,
                    lastEditedAt: 100,
                    value: [unknown],
                },
            },
        }));

        const loaded = readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions');
        expect(loaded).toEqual([unknown]);

        writeSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions', loaded ?? [], 200);
        flushSessionDraftValues(scopeA);
        invalidateSessionDraftValueCache(scopeA);

        const restored = readSessionDraftValue(scopeA, 'session-1', 'structuredInput.mentions');
        expect(restored).toEqual([unknown]);
        expect(buildStructuredInputMetaOverrides({
            mentions: restored ?? [],
            text: '@session:abc',
        })).toEqual({
            happierStructuredInputV1: {
                v: 1,
                mentions: [{
                    kind: 'happier.session',
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'abc'),
                    label: 'Session abc',
                    token: '@session:abc',
                }],
            },
        });
    });

    it('flushes pending writes before switching owners by exposing explicit invalidation and flush controls', () => {
        writeSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery', 'interrupt', 100);
        flushSessionDraftValues(scopeA);
        invalidateSessionDraftValueCache(scopeA);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBe('interrupt');

        clearSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery');
        flushSessionDraftValues(scopeA);
        invalidateSessionDraftValueCache(scopeA);

        expect(readSessionDraftValue(scopeA, 'session-1', 'routing.executionRunDelivery')).toBeUndefined();
    });
});
