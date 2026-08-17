import { describe, expect, it } from 'vitest';

import { resolveSessionViewModeOptionIds } from './resolveSessionViewModeOptionIds';

// Fixtures use `agentId` because that is the only key the canonical owner metadata can
// carry: `sessionModesV1` is strict on the wire, the nested store schema strips unknown
// keys, and the read-side normalizer renames the legacy `provider` alias to `agentId`
// before it ever reaches this resolver.
describe('resolveSessionViewModeOptionIds', () => {
    it('reuses the same empty array when no mode options are available', () => {
        const first = resolveSessionViewModeOptionIds('codex', null, { kind: 'none' });
        const second = resolveSessionViewModeOptionIds('codex', null, { kind: 'none' });

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('reuses the same non-empty array for identical dynamic agent mode inputs', () => {
        const input = {
            agentId: 'codex',
            availableModes: [
                { id: 'default' },
                { id: 'plan' },
                { id: ' ' },
            ],
        } as const;

        const first = resolveSessionViewModeOptionIds('codex', input, { kind: 'none' });
        const second = resolveSessionViewModeOptionIds('codex', input, { kind: 'none' });

        expect(first).toBe(second);
        expect(first).toEqual(['default', 'plan']);
    });

    it('returns dynamic agent mode ids when the session metadata matches the active agent', () => {
        expect(resolveSessionViewModeOptionIds('codex', {
            agentId: 'codex',
            availableModes: [
                { id: 'default' },
                { id: 'plan' },
                { id: ' ' },
            ],
        }, { kind: 'none' })).toEqual(['default', 'plan']);
    });

    it('ignores dynamic modes published by a different agent', () => {
        expect(resolveSessionViewModeOptionIds('claude', {
            agentId: 'codex',
            availableModes: [
                { id: 'default' },
                { id: 'plan' },
            ],
        }, { kind: 'none' })).toEqual([]);
    });

    it('keeps distinct results for the same agent when the publishing agent differs', () => {
        const availableModes = [{ id: 'default' }, { id: 'plan' }] as const;

        expect(resolveSessionViewModeOptionIds('codex', { agentId: 'codex', availableModes }, { kind: 'none' }))
            .toEqual(['default', 'plan']);
        expect(resolveSessionViewModeOptionIds('codex', { agentId: 'claude', availableModes }, { kind: 'none' }))
            .toEqual([]);
    });

    it('falls back to static agent modes when no dynamic session state is available', () => {
        const result = resolveSessionViewModeOptionIds('claude', null, {
            kind: 'staticAgentModes',
            staticOptions: [
                { id: 'default' },
                { id: 'fast' },
                { id: '' },
            ],
        });

        expect(result).toEqual(['default', 'fast']);
    });
});
