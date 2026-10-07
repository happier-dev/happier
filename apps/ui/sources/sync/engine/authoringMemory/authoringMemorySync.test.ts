import { describe, expect, it } from 'vitest';
import { createAuthoringMemorySync, importLegacyAuthoringMemory, type AuthoringMemoryTransport } from './authoringMemorySync';
import type { AuthoringMemoryContentV1 } from '@happier-dev/protocol';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';

function harness() {
    const rows = new Map<string, { revision: number; content: AuthoringMemoryContentV1 | null }>();
    const fetched: string[] = [];
    let projection: Record<string, unknown> = {};
    let current = true;
    const transport: AuthoringMemoryTransport = {
        list: async () => ({ rows: [...rows].map(([key, row]) => ({ key, ...row })) }),
        read: async (key: string) => {
            fetched.push(key);
            const row = rows.get(key);
            return !row ? { status: 'absent' as const }
                : row.content === null ? { status: 'deleted' as const, revision: row.revision }
                : { status: 'present' as const, revision: row.revision, content: row.content };
        },
        mutate: async (key: string, expectedRevision: number | 'absent', content: AuthoringMemoryContentV1 | null) => {
            const previous = rows.get(key);
            if ((previous?.revision ?? 'absent') !== expectedRevision) {
                return { status: 'conflict' as const, revision: previous?.revision ?? 0 };
            }
            const revision = (previous?.revision ?? -1) + 1;
            rows.set(key, { revision, content });
            return { status: 'updated' as const, revision, cursor: revision + 1 };
        },
    };
    const owner = createAuthoringMemorySync({
        transport,
        cipher: createAuthoringMemoryCipher({ mode: 'plain', material: null,
            randomBytes: () => { throw new Error('Plain memory must not request a key or randomness'); } }),
        isCurrent: () => current,
        apply: (delta) => { projection = { ...projection, ...delta }; },
    });
    return { owner, rows, fetched, projection: () => projection, retire: () => { current = false; } };
}

describe('Account authoring memory owner', () => {
    it('projects persisted engine rows with additive carrier fields and keeps opaque selection values', async () => {
        const h = harness();
        const scope = 'home:agent:happier.agent.codex/codex';
        const selection = { v: 9, futureSelection: { extra: true } };
        h.rows.set(`engineSelection:${scope}`, { revision: 0, content: { t: 'plain', v: {
            v: 1, selectionsByScope: { [scope]: selection }, futureCarrierField: true,
        } } });
        await h.owner.bootstrap();
        expect(h.projection().lastEngineSelectionsByScopeV1).toEqual({ [scope]: selection });
    });
    it('refreshes one hinted row without fetching or replacing neighboring memory', async () => {
        const h = harness();
        h.rows.set('lastUsedProfile', { revision: 0, content: { t: 'plain', v: 'p1' } });
        h.rows.set('recentMachinePaths', { revision: 0, content: { t: 'plain', v: [{ machineId: 'm', path: '/work' }] } });
        await h.owner.bootstrap();
        h.rows.set('lastUsedProfile', { revision: 1, content: { t: 'plain', v: 'p2' } });
        await h.owner.refresh('lastUsedProfile');
        expect(h.fetched).toEqual(['lastUsedProfile']);
        expect(h.projection()).toMatchObject({ lastUsedProfile: 'p2', recentMachinePaths: [{ machineId: 'm', path: '/work' }] });
    });

    it('does not apply an old Account/Home response after its scope retires', async () => {
        const h = harness();
        h.rows.set('lastUsedProfile', { revision: 0, content: { t: 'plain', v: 'private-profile' } });
        h.retire();
        await expect(h.owner.bootstrap()).rejects.toThrow();
        expect(h.projection()).toEqual({});
    });

    it('preserves an opaque selection when a typed replacement uses an absent base', async () => {
        const h = harness();
        const key = 'engineSelection:home:agent:happier.agent.codex/codex';
        const opaque = { v: 9, futureSelection: { id: 'keep' } };
        const value = { v: 1, selectionsByScope: { 'home:agent:happier.agent.codex/codex': opaque } };
        h.rows.set(key, { revision: 0, content: { t: 'plain', v: value } });
        await h.owner.bootstrap();
        await h.owner.applyDelta({ rememberedEngineSelectionReplacement: { base: {}, proposed: {
            'home:agent:happier.agent.codex/codex': { v: 1, modelSelection: null, updatedAt: 1 },
        } } });
        expect(h.rows.get(key)?.content).toEqual({ t: 'plain', v: value });
    });
});

describe('legacy Account authoring import', () => {
    it('preserves opaque data on canonical scope aliases inside one selection row', async () => {
        const h = harness();
        const canonicalScope = 'home:agent:happier.agent.codex/codex';
        const selections = {
            'home:backend:codex': { v: 1, modelId: 'gpt-5.4', updatedAt: 1 },
            [canonicalScope]: { v: 8, futureSelection: 'keep' },
        };
        let raw: Record<string, unknown> = { lastEngineSelectionsByScopeV1: selections };
        await importLegacyAuthoringMemory({ owner: h.owner, settings: {
            read: async () => ({ raw, version: 1 }),
            remove: async () => { raw = {}; return 'applied'; },
        } });
        expect(h.rows.size).toBe(1);
        expect(h.rows.get(`engineSelection:${canonicalScope}`)?.content).toEqual({
            t: 'plain', v: { v: 1, selectionsByScope: selections },
        });
        expect(h.projection().lastEngineSelectionsByScopeV1).toEqual(selections);
    });

    it('imports absent rows, survives interrupted retirement, and never overwrites on repeat', async () => {
        const h = harness();
        let raw: Record<string, unknown> = { lastUsedProfile: 'old', unrelated: { keep: true } };
        let interrupted = true;
        const settings = {
            read: async () => ({ raw, version: 1 }),
            remove: async (_key: string, _version: number) => {
                if (interrupted) throw new Error('interrupted');
                raw = { unrelated: raw.unrelated };
                return 'applied' as const;
            },
        };
        await expect(importLegacyAuthoringMemory({ owner: h.owner, settings })).rejects.toThrow('interrupted');
        expect(h.rows.get('lastUsedProfile')?.content).toEqual({ t: 'plain', v: 'old' });
        h.rows.set('lastUsedProfile', { revision: 1, content: { t: 'plain', v: 'new' } });
        interrupted = false;
        await importLegacyAuthoringMemory({ owner: h.owner, settings });
        await importLegacyAuthoringMemory({ owner: h.owner, settings });
        expect(raw).toEqual({ unrelated: { keep: true } });
        expect(h.rows.get('lastUsedProfile')?.content).toEqual({ t: 'plain', v: 'new' });
    });

    it('re-reads settings after CAS conflict and removes only the committed source key', async () => {
        const h = harness();
        let raw: Record<string, unknown> = { lastUsedProfile: 'p1', unrelated: 1 };
        let version = 0;
        await importLegacyAuthoringMemory({ owner: h.owner, settings: {
            read: async () => ({ raw, version }),
            remove: async (key, expected) => {
                if (version === 0) { raw = { ...raw, unrelated: 2 }; version = 1; return 'conflict'; }
                expect(expected).toBe(1);
                const next = { ...raw };
                delete next[key];
                raw = next;
                return 'applied';
            },
        } });
        expect(raw).toEqual({ unrelated: 2 });
        expect(h.rows.get('lastUsedProfile')?.content).toEqual({ t: 'plain', v: 'p1' });
    });
});
