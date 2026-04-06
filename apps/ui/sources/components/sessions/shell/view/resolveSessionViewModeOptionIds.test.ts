import { describe, expect, it } from 'vitest';

import { resolveSessionViewModeOptionIds } from './resolveSessionViewModeOptionIds';

describe('resolveSessionViewModeOptionIds', () => {
    it('reuses the same empty array when no mode options are available', () => {
        const first = resolveSessionViewModeOptionIds('codex', null, { kind: 'none' });
        const second = resolveSessionViewModeOptionIds('codex', null, { kind: 'none' });

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('reuses the same non-empty array for identical dynamic provider mode inputs', () => {
        const input = {
            provider: 'codex',
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

    it('returns dynamic provider mode ids when the session metadata matches the active agent', () => {
        expect(resolveSessionViewModeOptionIds('codex', {
            provider: 'codex',
            availableModes: [
                { id: 'default' },
                { id: 'plan' },
                { id: ' ' },
            ],
        }, { kind: 'none' })).toEqual(['default', 'plan']);
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
