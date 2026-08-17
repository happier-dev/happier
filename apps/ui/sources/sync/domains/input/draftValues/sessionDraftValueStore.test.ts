import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAccountScope } from '../../scope/serverAccountScope';

const store = vi.hoisted(() => new Map<string, string>());
const writesByKey = vi.hoisted(() => new Map<string, number>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            writesByKey.set(key, (writesByKey.get(key) ?? 0) + 1);
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

type SessionDraftValueFieldId =
    | 'routing.recipient'
    | 'routing.agentContinuation'
    | 'routing.executionRunDelivery'
    | 'structuredInput.mentions';

type SessionArmedAgentContinuation = Readonly<{
    backendTargetKey: string;
    intent: Readonly<{
        v: 1;
        mode: 'same_session';
        sourceAgentId: string;
        selection: Readonly<{ v: 1; agentId: string }>;
    }>;
    modelLabel: string | null;
}>;

const armedContinuation: SessionArmedAgentContinuation = {
    backendTargetKey: 'builtInAgent:codex',
    intent: {
        v: 1,
        mode: 'same_session',
        sourceAgentId: 'claude',
        selection: { v: 1, agentId: 'codex' },
    },
    modelLabel: null,
};

type ComposerStructuredInputMention =
    | Readonly<{
        kind: 'vendorPlugin';
        tokenText: string;
        vendorPluginRef: string;
        label?: string;
        backendId?: string;
        agentId?: string;
    }>
    | Readonly<{
        kind: 'skill';
        tokenText: string;
        name: string;
        path?: string;
        displayName?: string;
        description?: string;
        origin?: string;
        projectionKind?: string;
    }>
    // INV-4: a mention whose kind this build does not know is carried through inert.
    | Readonly<{
        kind: string;
        tokenText: string;
    }>;

type SessionDraftValueByFieldId = Readonly<{
    'routing.recipient': ParticipantRecipientV1 | null;
    'routing.agentContinuation': SessionArmedAgentContinuation;
    'routing.executionRunDelivery': 'prompt' | 'steer_if_supported' | 'interrupt';
    'structuredInput.mentions': readonly ComposerStructuredInputMention[];
}>;

type SessionDraftValueStoreModule = Readonly<{
    SESSION_DRAFT_VALUE_FIELD_IDS: readonly SessionDraftValueFieldId[];
    readSessionDraftValue: <TFieldId extends SessionDraftValueFieldId>(
        scope: ServerAccountScope | null | undefined,
        sessionId: string,
        fieldId: TFieldId,
    ) => unknown;
    writeSessionDraftValue: <TFieldId extends SessionDraftValueFieldId>(
        scope: ServerAccountScope | null | undefined,
        sessionId: string,
        fieldId: TFieldId,
        value: SessionDraftValueByFieldId[TFieldId],
        options?: Readonly<{ now?: number; flush?: boolean }>,
    ) => void;
    clearSessionDraftValue: (
        scope: ServerAccountScope | null | undefined,
        sessionId: string,
        fieldId: SessionDraftValueFieldId,
        options?: Readonly<{ flush?: boolean }>,
    ) => void;
    clearSessionDraftValues: (
        scope: ServerAccountScope | null | undefined,
        sessionId: string,
        options: Readonly<{ lifecycle: 'outboundHandoff' | 'composerCleared' | 'sessionDeleted' | 'abort'; flush?: boolean }>,
    ) => void;
    garbageCollectSessionDraftValues: (
        scope: ServerAccountScope | null | undefined,
        options: Readonly<{ now: number; reason: 'scopeActivated' | 'foreground' | 'idle'; flush?: boolean }>,
    ) => void;
    flushSessionDraftValues: (scope?: ServerAccountScope | null) => void;
    invalidateSessionDraftValuesCache: (scope?: ServerAccountScope | null) => void;
    resetSessionDraftValuesCachesForTests: () => void;
}>;

type SessionLocalStateKeysModule = Readonly<{
    sessionDraftValuesStorageKey: (scope?: ServerAccountScope | null) => string;
}>;

type SessionDraftValuesPersistenceModule = Readonly<{
    savePersistedSessionDraftValues: (
        values: Record<string, Record<string, Readonly<{ v: number; lastEditedAt: number; value: unknown }>>>,
        scope?: ServerAccountScope | null,
    ) => void;
    loadPersistedSessionDraftValues: (
        scope?: ServerAccountScope | null,
    ) => Record<string, Record<string, Readonly<{ v: number; lastEditedAt: number; value: unknown }>>>;
}>;

type SessionDraftValueFieldCatalogModule = Readonly<{
    SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS: number;
    SESSION_DRAFT_VALUE_FIELDS: Readonly<Record<SessionDraftValueFieldId, Readonly<{
        clearOn: Readonly<{ ttlDays?: number }>;
    }>>>;
}>;

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };
const recipient = {
    kind: 'agent_team_member',
    teamId: 'team_1',
    memberId: 'member_1',
    memberLabel: 'Reviewer',
} satisfies ParticipantRecipientV1;

async function importStore(): Promise<SessionDraftValueStoreModule> {
    return await import('./sessionDraftValueStore');
}

async function importKeys(): Promise<SessionLocalStateKeysModule> {
    return await import('../../state/sessionLocalStateKeys');
}

async function importPersistence(): Promise<SessionDraftValuesPersistenceModule> {
    return await import('../../state/sessionDraftValuesPersistence');
}

async function importFieldCatalog(): Promise<SessionDraftValueFieldCatalogModule> {
    return await import('./sessionDraftValueFieldCatalog');
}

describe('session draft-value store', () => {
    beforeEach(() => {
        store.clear();
        writesByKey.clear();
        vi.resetModules();
    });

    it('exposes the registered semantic field ids required by the composer draft contract', async () => {
        const draftValues = await importStore();

        expect(draftValues.SESSION_DRAFT_VALUE_FIELD_IDS).toEqual([
            'routing.recipient',
            'routing.agentContinuation',
            'routing.executionRunDelivery',
            'structuredInput.mentions',
        ]);
    });

    it('keeps an armed Agent across a reload, sheds it at outbound handoff, and holds it through a composer clear', async () => {
        const draftValues = await importStore();

        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.agentContinuation', armedContinuation, { now: 100 });
        draftValues.invalidateSessionDraftValuesCache(scopeA);
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.agentContinuation')).toEqual(armedContinuation);

        // The live picker stays armed through a composer action, so the persisted
        // half must too: one choice, one lifetime. Cancelling is its own gesture.
        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.recipient', recipient, { now: 100 });
        draftValues.clearSessionDraftValues(scopeA, 'sessionA', { lifecycle: 'composerCleared' });
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.recipient')).toBeUndefined();
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.agentContinuation')).toEqual(armedContinuation);

        // The arm leaves with the message that consumed it.
        draftValues.clearSessionDraftValues(scopeA, 'sessionA', { lifecycle: 'outboundHandoff' });
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.agentContinuation')).toBeUndefined();
    });

    it('refuses an armed Agent with no row to point at rather than restoring half of one', async () => {
        const draftValues = await importStore();

        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.agentContinuation', armedContinuation, { now: 100 });
        draftValues.writeSessionDraftValue(
            scopeA,
            'sessionA',
            'routing.agentContinuation',
            { ...armedContinuation, backendTargetKey: '' },
            { now: 200 },
        );

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.agentContinuation')).toEqual(armedContinuation);
    });

    it('uses the named semantic draft-value TTL configuration for every registered field', async () => {
        const catalog = await importFieldCatalog();

        expect(catalog.SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS).toBeGreaterThan(0);
        for (const fieldId of [
            'routing.recipient',
            'routing.agentContinuation',
            'routing.executionRunDelivery',
            'structuredInput.mentions',
        ] as const) {
            expect(catalog.SESSION_DRAFT_VALUE_FIELDS[fieldId].clearOn.ttlDays).toBe(
                catalog.SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
            );
        }
    });

    it('writes and reads typed values through a scope-isolated cache', async () => {
        const draftValues = await importStore();

        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.recipient', recipient, { now: 1000 });
        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery', 'interrupt', { now: 1001 });
        draftValues.writeSessionDraftValue(scopeB, 'sessionA', 'routing.executionRunDelivery', 'prompt', { now: 1002 });

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.recipient')).toEqual(recipient);
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery')).toBe('interrupt');
        expect(draftValues.readSessionDraftValue(scopeB, 'sessionA', 'routing.executionRunDelivery')).toBe('prompt');
        expect(draftValues.readSessionDraftValue(undefined, 'sessionA', 'routing.executionRunDelivery')).toBeUndefined();
    });

    it('drops unknown and schema-invalid fields without dropping valid siblings', async () => {
        const persistence = await importPersistence();
        persistence.savePersistedSessionDraftValues({
            sessionA: {
                'routing.recipient': { v: 1, lastEditedAt: 100, value: recipient },
                'routing.executionRunDelivery': { v: 1, lastEditedAt: 101, value: 'invalid' },
                unknown: { v: 1, lastEditedAt: 102, value: 'x' },
                'structuredInput.mentions': { v: 1, lastEditedAt: 103, value: [{ kind: 'skill', tokenText: '@bad' }] },
            },
        }, scopeA);

        const draftValues = await importStore();

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.recipient')).toEqual(recipient);
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery')).toBeUndefined();
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions')).toBeUndefined();

        draftValues.flushSessionDraftValues(scopeA);
        expect(persistence.loadPersistedSessionDraftValues(scopeA)).toEqual({
            sessionA: {
                'routing.recipient': { v: 1, lastEditedAt: 100, value: recipient },
            },
        });
    });

    it('does not dirty or rewrite valid persisted values when hydrating after cache invalidation', async () => {
        const persistence = await importPersistence();
        const keys = await importKeys();
        const scopedKey = keys.sessionDraftValuesStorageKey(scopeA);
        persistence.savePersistedSessionDraftValues({
            sessionA: {
                'routing.executionRunDelivery': { v: 1, lastEditedAt: 100, value: 'interrupt' },
            },
        }, scopeA);
        writesByKey.clear();

        const draftValues = await importStore();
        draftValues.invalidateSessionDraftValuesCache(scopeA);

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery')).toBe('interrupt');
        draftValues.flushSessionDraftValues(scopeA);

        expect(writesByKey.get(scopedKey) ?? 0).toBe(0);
        expect(persistence.loadPersistedSessionDraftValues(scopeA)).toEqual({
            sessionA: {
                'routing.executionRunDelivery': { v: 1, lastEditedAt: 100, value: 'interrupt' },
            },
        });
    });

    it('clears only fields registered for the requested lifecycle and prunes empty sessions', async () => {
        const draftValues = await importStore();
        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.recipient', recipient, { now: 100, flush: false });
        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery', 'interrupt', { now: 101, flush: false });
        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions', [{
            kind: 'skill',
            tokenText: '@skill',
            name: 'skill',
        }], { now: 102, flush: false });

        draftValues.clearSessionDraftValues(scopeA, 'sessionA', { lifecycle: 'outboundHandoff', flush: false });

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.recipient')).toBeUndefined();
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery')).toBeUndefined();
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions')).toBeUndefined();

        draftValues.flushSessionDraftValues(scopeA);
        const persistence = await importPersistence();
        expect(persistence.loadPersistedSessionDraftValues(scopeA)).toEqual({});
    });

    it('preserves outbound-handoff fields on abort and clears them for composer clear', async () => {
        const draftValues = await importStore();
        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.recipient', recipient, { now: 100 });

        draftValues.clearSessionDraftValues(scopeA, 'sessionA', { lifecycle: 'abort' });
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.recipient')).toEqual(recipient);

        draftValues.clearSessionDraftValues(scopeA, 'sessionA', { lifecycle: 'composerCleared' });
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.recipient')).toBeUndefined();
    });

    it('garbage-collects stale field envelopes by field TTL while preserving fresh envelopes', async () => {
        const dayMs = 24 * 60 * 60 * 1000;
        const draftValues = await importStore();
        draftValues.writeSessionDraftValue(scopeA, 'stale', 'routing.recipient', recipient, {
            now: 1000,
            flush: false,
        });
        draftValues.writeSessionDraftValue(scopeA, 'fresh', 'routing.recipient', recipient, {
            now: 1000 + 29 * dayMs,
            flush: false,
        });

        draftValues.garbageCollectSessionDraftValues(scopeA, {
            now: 1000 + 31 * dayMs,
            reason: 'foreground',
        });

        expect(draftValues.readSessionDraftValue(scopeA, 'stale', 'routing.recipient')).toBeUndefined();
        expect(draftValues.readSessionDraftValue(scopeA, 'fresh', 'routing.recipient')).toEqual(recipient);
    });

    it('dedupes identical cache writes and flushes only dirty scoped values', async () => {
        const draftValues = await importStore();
        const keys = await importKeys();
        const scopedKey = keys.sessionDraftValuesStorageKey(scopeA);

        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery', 'prompt', { now: 100 });
        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery', 'prompt', { now: 200 });
        draftValues.flushSessionDraftValues(scopeA);

        expect(writesByKey.get(scopedKey)).toBe(1);
    });

    it('keeps the surviving draft mentions when one persisted element is malformed (D-14)', async () => {
        const persistence = await importPersistence();
        const good = { kind: 'skill' as const, tokenText: '$review', name: 'review' };
        persistence.savePersistedSessionDraftValues({
            sessionA: {
                'structuredInput.mentions': {
                    v: 1,
                    lastEditedAt: 100,
                    // The second element has no `name`, so the skill arm rejects it.
                    value: [good, { kind: 'skill', tokenText: '$broken' }],
                },
            },
        }, scopeA);

        const draftValues = await importStore();

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions')).toEqual([good]);
    });

    it('preserves a mention of an unknown kind through load, re-save and read (INV-4)', async () => {
        const persistence = await importPersistence();
        const unknown = { kind: 'happier.session', tokenText: '@session:abc' };
        persistence.savePersistedSessionDraftValues({
            sessionA: {
                'structuredInput.mentions': { v: 1, lastEditedAt: 100, value: [unknown] },
            },
        }, scopeA);

        const draftValues = await importStore();
        // The locally declared store module types reads as `unknown`; the round trip is the
        // point of this test, so the loaded value is written back rather than a fresh literal.
        const loaded = draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions') as
            readonly ComposerStructuredInputMention[] | undefined;
        expect(loaded).toEqual([unknown]);

        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions', loaded ?? [], { now: 200 });
        draftValues.invalidateSessionDraftValuesCache(scopeA);

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions')).toEqual([unknown]);
    });

    it('keeps the skill identity tuple across a draft round trip, so the same draft sends the same reference', async () => {
        // `z.object` strips undeclared keys, so a field the persisted schema forgets is lost
        // silently on restore. These four are exactly what `resolveSkillCatalogItemIdentityV1`
        // derives a `happier.skill` reference from — losing any of them makes the same composer
        // content send a DIFFERENT envelope after an app restart. `path` is deliberately not in
        // that tuple: it is provider context, re-resolved at send time.
        const skill = {
            kind: 'skill' as const,
            tokenText: '$review',
            id: 'vendor:codex:review',
            name: 'review',
            path: '/w/.codex/skills/review/SKILL.md',
            origin: 'codex_native',
            backendId: 'codex',
            projectionRef: 'projected-review',
            agentId: 'agent-1',
        };
        const persistence = await importPersistence();
        persistence.savePersistedSessionDraftValues({
            sessionA: { 'structuredInput.mentions': { v: 1, lastEditedAt: 100, value: [skill] } },
        }, scopeA);

        const draftValues = await importStore();
        const loaded = draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions') as
            readonly ComposerStructuredInputMention[] | undefined;
        expect(loaded).toEqual([skill]);

        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions', loaded ?? [], { now: 200 });
        draftValues.invalidateSessionDraftValuesCache(scopeA);

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions')).toEqual([skill]);
    });

    it('round-trips a session mention (EU-7)', async () => {
        const session = {
            kind: 'session' as const,
            tokenText: '@session:fix-startup-v4a0a7',
            sessionId: 'cmslj08960ku1tmhrd0v4a0a7',
            label: 'Fix Detached Dev Stack Startup',
        };
        const persistence = await importPersistence();
        persistence.savePersistedSessionDraftValues({
            sessionA: { 'structuredInput.mentions': { v: 1, lastEditedAt: 100, value: [session] } },
        }, scopeA);

        const draftValues = await importStore();

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions')).toEqual([session]);
    });

    it('loads a draft written before mentions dropped their positions', async () => {
        // Positions were part of the persisted shape until they stopped gating anything. A
        // draft that still carries them must load, not be discarded as malformed: the known
        // arms are plain objects so zod strips the extra keys, and the unknown arm is
        // passthrough so a newer build's fields still survive this build (INV-4).
        const persistence = await importPersistence();
        persistence.savePersistedSessionDraftValues({
            sessionA: {
                'structuredInput.mentions': {
                    v: 1,
                    lastEditedAt: 100,
                    value: [
                        { kind: 'skill', tokenText: '$review', start: 0, end: 7, name: 'review' },
                        { kind: 'acme.ticket', tokenText: '@ACME-1', start: 8, end: 15 },
                    ],
                },
            },
        }, scopeA);

        const draftValues = await importStore();

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'structuredInput.mentions')).toEqual([
            { kind: 'skill', tokenText: '$review', name: 'review' },
            { kind: 'acme.ticket', tokenText: '@ACME-1', start: 8, end: 15 },
        ]);
    });

    it('reloads scoped values after cache invalidation without leaking another scope', async () => {
        const draftValues = await importStore();
        const persistence = await importPersistence();

        draftValues.writeSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery', 'prompt', { now: 100 });
        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery')).toBe('prompt');

        persistence.savePersistedSessionDraftValues({
            sessionA: {
                'routing.executionRunDelivery': { v: 1, lastEditedAt: 200, value: 'interrupt' },
            },
        }, scopeA);
        persistence.savePersistedSessionDraftValues({
            sessionA: {
                'routing.executionRunDelivery': { v: 1, lastEditedAt: 300, value: 'steer_if_supported' },
            },
        }, scopeB);

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery')).toBe('prompt');

        draftValues.invalidateSessionDraftValuesCache(scopeA);

        expect(draftValues.readSessionDraftValue(scopeA, 'sessionA', 'routing.executionRunDelivery')).toBe('interrupt');
        expect(draftValues.readSessionDraftValue(scopeB, 'sessionA', 'routing.executionRunDelivery')).toBe('steer_if_supported');
    });
});
