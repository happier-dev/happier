import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { MachineAttentionEntry } from '@/components/machines/attention/collectMachineAttention';

import { useMachineIndexCardAttention } from './machineIndexCardAttention';

type Item = Readonly<{ key: string; reason: string | null; machine: string }>;
const machineKey = (item: Item) => item.machine;
const entry = (key: string) => ({ key }) as unknown as MachineAttentionEntry;
const sections = (...keys: string[]) => [{ items: keys.map((key): Item => ({ key, reason: null, machine: `m:${key}` })) }];

describe('useMachineIndexCardAttention', () => {
    // The anatomy (and so every Collection row) is keyed on this map: a rebuild with the same statements must
    // keep its identity, or each Machine list publication re-renders every row of the fleet.
    it('keeps its identity while the statements are unchanged, in the table and in the grid', async () => {
        const a = entry('m:a');
        const subjects = [a];
        for (const grid of [false, true]) {
            const hook = await renderHook(
                (props: { sections: ReturnType<typeof sections>; subjects: readonly MachineAttentionEntry[] }) =>
                    useMachineIndexCardAttention(grid, props.subjects, props.sections, machineKey),
                { initialProps: { sections: sections('a', 'b'), subjects } },
            );
            const first = hook.getCurrent();
            await hook.rerender({ sections: sections('a', 'b', 'c'), subjects: [a] });
            expect(hook.getCurrent()).toBe(first);
            if (grid) {
                await hook.rerender({ sections: sections('a', 'b', 'c'), subjects: [a, entry('m:c')] });
                expect([...hook.getCurrent().keys()]).toEqual(['a', 'c']);
            }
        }
    });
});
