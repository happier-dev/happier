import { describe, expect, it, vi } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { buildSessionListFacets } = await import('./sessionListFacets');

const controller = (overrides: object = {}) => {
    const updateFilters = vi.fn();
    return {
        filters: { ...normalizeSessionListFilterV1({} as never), searchQuery: '', ...overrides },
        includeInactive: true,
        updateFilters,
        setSource: vi.fn(),
        setIncludeInactive: vi.fn(),
        resetFilters: vi.fn(),
    } as never as Parameters<typeof buildSessionListFacets>[0] & { updateFilters: typeof updateFilters };
};

describe('Sessions title menu filters', () => {
    it('filters by what needs you, or by a work status, in one press through the Session filter registry', () => {
        const owner = controller();
        const chips = buildSessionListFacets(owner);
        expect(chips.map(chip => chip.id)).toEqual(['needs-you', 'working', 'failed']);
        expect(chips.every(chip => chip.selected === false && typeof chip.onToggle === 'function')).toBe(true);
        chips[0]!.onToggle!();
        expect(owner.updateFilters.mock.calls.at(-1)![0]).toMatchObject({ attention: 'needs_my_attention' });
        chips[1]!.onToggle!();
        expect(owner.updateFilters.mock.calls.at(-1)![0].statuses?.length).toBeGreaterThan(0);
    });

    it('shows a filter that is on, and one press turns it off', () => {
        const owner = controller({ attention: 'needs_my_attention' });
        const chip = buildSessionListFacets(owner)[0]!;
        expect(chip.selected).toBe(true);
        chip.onToggle!();
        expect(owner.updateFilters.mock.calls.at(-1)![0]).toMatchObject({ attention: 'any' });
    });
});
