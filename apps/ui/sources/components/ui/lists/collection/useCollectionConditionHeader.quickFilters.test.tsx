import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { discussionListFilterFieldsV1 } from '@happier-dev/protocol/discussions/listing/discussionListFilterV1';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { useCollectionConditionHeader } = await import('./useCollectionConditionHeader');

const bindings = { fields: { attention: { label: 'Needs you', valueOptions: [{ value: true, label: 'Needs you' }] } } };
const QUICK = [{ fieldId: 'attention', value: true, label: 'Needs you' }] as const;

afterEach(standardCleanup);

describe('useCollectionConditionHeader quick filters', () => {
    it('turns a declared value on in one press, and states it once: as a chip, never also a token', async () => {
        const seen: unknown[] = [];
        const rendered = await renderHook(() => {
            const [filters, setFilters] = React.useState<Parameters<typeof discussionListFilterFieldsV1[number]['compile']>[0]>({} as never);
            return useCollectionConditionHeader({
                testIDPrefix: 'test', registry: discussionListFilterFieldsV1, bindings: bindings as never,
                filters, setFilters: (next) => { seen.push(next); setFilters(next); }, baseFilter: {} as never, quickFilters: QUICK,
            });
        });
        const chips = () => rendered.getCurrent().quickFilterChips;
        expect(chips().map((chip) => [chip.label, chip.selected])).toEqual([['Needs you', false]]);
        await act(async () => { chips()[0]!.onToggle!(); });
        expect(seen).toHaveLength(1);
        expect(chips()[0]!.selected).toBe(true);
        expect(rendered.getCurrent().tokens).toEqual([]);
        await rendered.unmount();
    });
});
