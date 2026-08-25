import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

type TestAccountLifetime = Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>;
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

function createTestAccountLifetime(accountId: string) {
    let retired = false;
    const cancellations = new Set<() => void>();
    const lifetime: TestAccountLifetime = {
        scope: { serverId: 'server-a', accountId },
        isCurrent: () => !retired,
        onRetire(cancel: () => void) {
            if (retired) {
                cancel();
                return { dispose() {} };
            }
            cancellations.add(cancel);
            return { dispose() { cancellations.delete(cancel); } };
        },
    };
    return {
        lifetime,
        retire() {
            if (retired) return;
            retired = true;
            for (const cancel of [...cancellations]) cancel();
            cancellations.clear();
        },
    };
}

const activeAccountLifetime: { value: TestAccountLifetime | null } = { value: null };

async function importHook() {
    vi.resetModules();
    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.value,
    }));
    return (await import('./accountLifetimeRetirement')).useRetireProviderStateOnAccountChange;
}

describe('useRetireProviderStateOnAccountChange', () => {
    afterEach(() => {
        activeAccountLifetime.value = null;
        standardCleanup();
    });

    it('retires Account-authored Provider state exactly once when the Account lifetime retires', async () => {
        const account = createTestAccountLifetime('account-a');
        activeAccountLifetime.value = account.lifetime;
        const useRetireProviderStateOnAccountChange = await importHook();
        const retire = vi.fn();
        await renderHook(() => useRetireProviderStateOnAccountChange(retire));

        expect(retire).not.toHaveBeenCalled();

        await act(async () => { account.retire(); });

        expect(retire).toHaveBeenCalledTimes(1);
    });

    it('does not retire Provider state while the same Account stays mounted', async () => {
        const account = createTestAccountLifetime('account-a');
        activeAccountLifetime.value = account.lifetime;
        const useRetireProviderStateOnAccountChange = await importHook();
        const retire = vi.fn();
        const rendered = await renderHook(() => useRetireProviderStateOnAccountChange(retire));

        await rendered.rerender();
        await rendered.rerender();

        expect(retire).not.toHaveBeenCalled();
    });

    it('stops listening once the consumer unmounts', async () => {
        const account = createTestAccountLifetime('account-a');
        activeAccountLifetime.value = account.lifetime;
        const useRetireProviderStateOnAccountChange = await importHook();
        const retire = vi.fn();
        const rendered = await renderHook(() => useRetireProviderStateOnAccountChange(retire));

        await rendered.unmount();
        await act(async () => { account.retire(); });

        expect(retire).not.toHaveBeenCalled();
    });
});
