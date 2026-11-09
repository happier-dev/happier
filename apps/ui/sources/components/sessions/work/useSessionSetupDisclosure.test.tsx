import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { clearPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { useSessionSetupDisclosure } from './useSessionSetupDisclosure';

afterEach(() => { standardCleanup(); clearPersistenceStorage(); });

describe('device Session Setup disclosure', () => {
    it('updates the mounted disclosure without publishing Settings on any interaction', async () => {
        const hook = await renderHook(() => useSessionSetupDisclosure());
        expect(hook.getCurrent().isExpanded('instructions')).toBe(true);
        expect(hook.getCurrent().isExpanded('memory')).toBe(false);
        const publications = vi.fn();
        const unsubscribe = getStorage().subscribe((next, previous) => {
            if (next.localSettings !== previous.localSettings || next.settings !== previous.settings) publications();
        });
        try {
            await act(async () => hook.getCurrent().setExpanded('memory', true));
            expect(hook.getCurrent().isExpanded('memory')).toBe(true);
            await act(async () => hook.getCurrent().setExpanded('instructions', false));
            expect(hook.getCurrent().isExpanded('instructions')).toBe(false);
            expect(publications).toHaveBeenCalledTimes(0);
        } finally { unsubscribe(); }
    });
});
