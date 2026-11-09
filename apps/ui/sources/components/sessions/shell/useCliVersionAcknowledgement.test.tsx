import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { useCliVersionAcknowledgement } from './useCliVersionAcknowledgement';

describe('device CLI version acknowledgement', () => {
    beforeEach(resetPersistentUiStateForTest);
    afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

    it('remembers only the exact Machine/version through a new visit without preference writes', async () => {
        const device = getPersistenceStorage();
        const localSettings = storage.getState().localSettings;
        const writes = vi.spyOn(device, 'set');
        const hook = await renderHook(() => useCliVersionAcknowledgement('machine-a', '0.0.0'));
        expect(hook.getCurrent().shouldShowCliWarning).toBe(true);
        await act(async () => { hook.getCurrent().handleDismissCliWarning(); });
        expect(hook.getCurrent().shouldShowCliWarning).toBe(false);
        expect(JSON.parse(device.getString('ui-state:cli-version-acknowledgements-v1:machines')!))
            .toEqual({ 'machine-a': '0.0.0' });
        expect(writes.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
        expect(storage.getState().localSettings).toBe(localSettings);
        await hook.unmount();
        const again = await renderHook(() => useCliVersionAcknowledgement('machine-a', '0.0.0'));
        expect(again.getCurrent().shouldShowCliWarning).toBe(false);
        const nextVersion = await renderHook(() => useCliVersionAcknowledgement('machine-a', '0.0.1'));
        expect(nextVersion.getCurrent().shouldShowCliWarning).toBe(true);
        const otherMachine = await renderHook(() => useCliVersionAcknowledgement('machine-b', '0.0.0'));
        expect(otherMachine.getCurrent().shouldShowCliWarning).toBe(true);
    });
});
