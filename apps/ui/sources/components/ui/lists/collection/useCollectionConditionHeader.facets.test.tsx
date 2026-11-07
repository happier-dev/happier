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

describe('useCollectionConditionHeader common filters', () => {
    it('toggles a declared value in one press, and says it on the token line like any other condition', async () => {
        const seen: unknown[] = [];
        const rendered = await renderHook(() => {
            const [filters, setFilters] = React.useState<Parameters<typeof discussionListFilterFieldsV1[number]['compile']>[0]>({} as never);
            return useCollectionConditionHeader({
                testIDPrefix: 'test', registry: discussionListFilterFieldsV1, bindings: bindings as never,
                filters, setFilters: (next) => { seen.push(next); setFilters(next); }, baseFilter: {} as never, facets: QUICK,
            });
        });
        const facets = () => rendered.getCurrent().facetToggles;
        expect(facets().map((facet) => [facet.label, facet.selected])).toEqual([['Needs you', false]]);
        // No chip row at rest: nothing is on, so nothing is drawn under the field.
        expect(rendered.getCurrent().tokenRow).toBeNull();
        await act(async () => { facets()[0]!.onToggle!(); });
        expect(seen).toHaveLength(1);
        expect(facets()[0]!.selected).toBe(true);
        expect(rendered.getCurrent().tokens.map((token) => token.valueLabel)).toEqual(['Needs you']);
        await rendered.unmount();
    });
});
