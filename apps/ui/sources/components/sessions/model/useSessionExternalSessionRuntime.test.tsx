import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const useExternalSessionRuntimeSpy = vi.hoisted(() => vi.fn());

vi.mock('./useExternalSessionRuntime', () => ({
    useExternalSessionRuntime: useExternalSessionRuntimeSpy,
}));

describe('useSessionExternalSessionRuntime', () => {
    beforeEach(() => {
        useExternalSessionRuntimeSpy.mockReset();
    });

    it('keeps the owned runtime disabled when a provider supplies the canonical runtime', async () => {
        const providedRuntime = {
            externalSessionLink: null,
            externalAgent: null,
            sessionServerId: 'server-1',
            status: null,
            refreshNow: vi.fn(async () => null),
        };
        const ownedRuntime = {
            ...providedRuntime,
            sessionServerId: 'unused-owned-server',
        };
        useExternalSessionRuntimeSpy.mockReturnValue(ownedRuntime);

        const {
            SessionExternalSessionRuntimeProvider,
            useSessionExternalSessionRuntime,
        } = await import('./useSessionExternalSessionRuntime');
        const wrapper = ({ children }: React.PropsWithChildren) => (
            <SessionExternalSessionRuntimeProvider value={providedRuntime}>
                {children}
            </SessionExternalSessionRuntimeProvider>
        );
        const hook = await renderHook(
            () => useSessionExternalSessionRuntime({
                sessionId: 'session-1',
                metadata: null,
            }),
            { wrapper },
        );

        expect(useExternalSessionRuntimeSpy).toHaveBeenCalledWith({
            sessionId: 'session-1',
            metadata: null,
            enabled: false,
        });
        expect(hook.getCurrent()).toBe(providedRuntime);

        await hook.unmount();
    });
});
