import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: () => null,
        useLocalSettingMutable: () => [null, vi.fn()],
    });
});

import { renderHook } from '@/dev/testkit';
import { AppPaneProvider } from '../AppPaneProvider';
import { useAppPaneScope } from './useAppPaneScope';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE_ID = 'session:identity-probe';

function PaneWrapper(props: React.PropsWithChildren) {
    return <AppPaneProvider>{props.children}</AppPaneProvider>;
}

describe('useAppPaneScope identity', () => {
    it('returns the same api object when the host re-renders with no pane change', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), {
            wrapper: PaneWrapper,
        });

        const first = harness.getCurrent();
        const second = await harness.rerender();
        const third = await harness.rerender();

        // The api is handed to `useCallback` dependency lists across ~29 callsites
        // (openAttachedSessionTerminal, SessionHeaderTranscriptNavigationButton, ...).
        // A fresh literal per render invalidates every one of them and defeats
        // SessionHeaderActionMenu's `onSelectExtraItem` comparator.
        expect(second).toBe(first);
        expect(third).toBe(first);

        await harness.unmount();
    });

    it('mints a new api object when the scope state actually changes', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), {
            wrapper: PaneWrapper,
        });

        const before = harness.getCurrent();
        expect(before.scopeState?.right?.isOpen ?? false).toBe(false);

        await harness.rerender();
        expect(harness.getCurrent()).toBe(before);

        const { act } = await import('react-test-renderer');
        await act(async () => {
            before.openRight();
        });

        const after = harness.getCurrent();
        expect(after).not.toBe(before);
        expect(after.scopeState?.right?.isOpen).toBe(true);

        await harness.unmount();
    });
});
