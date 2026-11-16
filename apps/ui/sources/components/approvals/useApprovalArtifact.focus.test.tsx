import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useApprovalArtifact } from './useApprovalArtifact';

// The shared setup replaces React Navigation with a static port; focus events are this test's subject,
// so the real library (its NavigationContext and useIsFocused) is the boundary here.
vi.unmock('@react-navigation/native');
const { NavigationContext } = await import('@react-navigation/native');

/**
 * Every mounted Action writer (a row's clipboard or reminder action, a settings writer) holds an approval
 * reader with no approval. React Navigation is the boundary here: a Stack screen's navigation object with
 * its real focus and blur events; the reader and the library's focus hook stay real.
 */
function createScreen() {
    let focused = true;
    const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
    const navigation = {
        isFocused: () => focused,
        addListener: (event: 'focus' | 'blur', listener: () => void) => {
            listeners[event].add(listener);
            return () => { listeners[event].delete(listener); };
        },
        getParent: () => undefined,
        getState: () => undefined,
    };
    return {
        Screen: (props: React.PropsWithChildren) => (
            <NavigationContext.Provider value={navigation as never}>{props.children}</NavigationContext.Provider>
        ),
        setFocused: (next: boolean) => {
            focused = next;
            for (const listener of [...listeners[next ? 'focus' : 'blur']]) listener();
        },
    };
}

describe('useApprovalArtifact focus', () => {
    afterEach(() => standardCleanup());

    it('keeps an absent approval reader still while its screen is covered and shown again', async () => {
        const { Screen, setFocused } = createScreen();
        let reader = 0;
        let control = 0;
        const hook = await renderHook(() => { reader += 1; return useApprovalArtifact({ artifactId: null, serverId: null }); }, { wrapper: Screen });
        const focusReader = await renderHook(() => { control += 1; return useOptionalScreenIsFocused(); }, { wrapper: Screen });
        try {
            await flushHookEffects();
            const before = { reader, control };
            await act(async () => { setFocused(false); });
            await act(async () => { setFocused(true); });
            // The control proves the screen's focus events reach a focus reader in this harness.
            expect({ reader: reader - before.reader, control: control - before.control }).toEqual({ reader: 0, control: 2 });
        } finally {
            await focusReader.unmount();
            await hook.unmount();
        }
    });
});
