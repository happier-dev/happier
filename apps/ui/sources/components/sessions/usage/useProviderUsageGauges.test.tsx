import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useProviderUsageGauges } from './useProviderUsageGauges';

// Display configuration is independent of sign-in/network activity in this test.
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ credentials: null }) }));

afterEach(() => standardCleanup());

function services(status: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable') {
    return AccountProfileSchema.parse({ id: 'account', connectedServicesV2: [{
        serviceId: 'openai-codex', profiles: [{ profileId: 'work', status }],
    }] }).connectedServicesV2;
}

describe('provider usage configuration visibility', () => {
    it('keeps a configured provider present through credential health changes, and removes it only when unconfigured', async () => {
        const hook = await renderHook((connectedServices: ReturnType<typeof services>) => useProviderUsageGauges({
            agentIds: ['codex'], accountProfileConnectedServicesV2: connectedServices,
            windowMode: 'most_constrained', fetchEnabled: false,
        }), { initialProps: services('connected') });
        try {
            for (const status of ['connected', 'refreshing', 'needs_reauth', 'refresh_failed_retryable'] as const) {
                await hook.rerender(services(status));
                expect(hook.getCurrent().configuredAgentIds.has('codex'), status).toBe(true);
            }
            await hook.rerender([]);
            expect(hook.getCurrent().configuredAgentIds.has('codex')).toBe(false);
        } finally { await hook.unmount(); }
    });
});
