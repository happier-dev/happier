import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { notifyShellColumnActionOwnersChanged, registerShellColumnActionOwner, type ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { usePaneArrangementAvailable } from './usePaneArrangement';

afterEach(standardCleanup);

it('publishes arrangement availability only when that boolean changes', async () => {
    let owner: ShellColumnActionOwner = { present: true, visible: true, available: true, arrangementAvailable: false, setVisible() {} };
    const unregister = registerShellColumnActionOwner('main', () => owner);
    let renders = 0;
    const hook = await renderHook(() => { renders++; return usePaneArrangementAvailable(); });
    try {
        const before = renders;
        await act(() => { owner = { ...owner, label: 'updated', activeTab: 'files' }; notifyShellColumnActionOwnersChanged(); });
        expect(renders).toBe(before);
        await act(() => { owner = { ...owner, arrangementAvailable: true }; notifyShellColumnActionOwnersChanged(); });
        expect(hook.getCurrent()).toBe(true);
        expect(renders).toBe(before + 1);
    } finally { await hook.unmount(); unregister(); }
});
