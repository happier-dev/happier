import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useAutomations } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';

afterEach(() => {
    standardCleanup();
});

/**
 * `updatedAt` is only read while ordering the Automation list. Counting reads
 * distinguishes "derive once per Automation change" from "re-derive on every
 * unrelated store mutation" — the returned array is reference-stable either
 * way, so identity alone cannot tell the two apart.
 */
function buildCountingAutomations(count: number): Readonly<{
    automations: Record<string, AutomationDefinition>;
    readUpdatedAtCount: () => number;
}> {
    let reads = 0;
    const automations: Record<string, AutomationDefinition> = {};
    for (let index = 0; index < count; index += 1) {
        const id = `automation-${index}`;
        automations[id] = Object.defineProperty(
            {
                id,
                name: id,
                enabled: true,
                templateVersion: 1,
                detail: { kind: 'unloaded' },
            } as unknown as AutomationDefinition,
            'updatedAt',
            {
                enumerable: true,
                get() {
                    reads += 1;
                    return count - index;
                },
            },
        );
    }
    return { automations, readUpdatedAtCount: () => reads };
}

describe('useAutomations', () => {
    it('does not re-derive the ordered Automation list for an unrelated store mutation', async () => {
        const previousState = storage.getState();
        try {
            const { automations, readUpdatedAtCount } = buildCountingAutomations(64);
            await act(async () => {
                storage.setState({ isDataReady: true, automations });
            });

            const rendered = await renderHook(() => useAutomations());
            expect(rendered.getCurrent()[0]?.id).toBe('automation-0');
            const readsAfterFirstDerivation = readUpdatedAtCount();
            expect(readsAfterFirstDerivation).toBeGreaterThan(0);

            await act(async () => {
                // An unrelated slice moves; the Automation record is untouched.
                storage.setState({ todosLoaded: true });
            });
            await rendered.rerender();

            expect(rendered.getCurrent()[0]?.id).toBe('automation-0');
            expect(readUpdatedAtCount()).toBe(readsAfterFirstDerivation);
            await rendered.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState, true);
            });
        }
    });
});
