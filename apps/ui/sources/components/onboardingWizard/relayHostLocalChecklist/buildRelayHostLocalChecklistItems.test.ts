import { describe, expect, it, vi } from 'vitest';

import type { RelayHostLocalChecklistRuntimeStatus } from './types';
import { buildRelayHostLocalChecklistItems } from './buildRelayHostLocalChecklistItems';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('buildRelayHostLocalChecklistItems', () => {
    it('marks missing relay runtime items as recommended and keeps secure access hidden until the runtime is installed', () => {
        const status: RelayHostLocalChecklistRuntimeStatus = {
            installed: false,
            version: null,
            relayUrl: 'http://localhost:53288',
            healthy: false,
            service: { active: false, enabled: false },
        };

        const items = buildRelayHostLocalChecklistItems({
            runtimeStatus: status,
            currentRelayUrl: null,
            currentShareableUrl: null,
        });

        expect(items).toHaveLength(2);
        expect(items[0]?.id).toBe('installRelayRuntime');
        expect(items[0]?.defaultSelected).toBe(true);
        expect(items[0]?.satisfied).toBe(false);
        expect(items[1]?.id).toBe('startRelayRuntime');
        expect(items[1]?.defaultSelected).toBe(true);
    });

    it('adds the optional secure-access row when the runtime relay URL is available and marks it satisfied once secure access exists', () => {
        const status: RelayHostLocalChecklistRuntimeStatus = {
            installed: true,
            version: '1.2.3',
            relayUrl: 'http://localhost:53288',
            healthy: true,
            service: { active: true, enabled: true },
        };

        const items = buildRelayHostLocalChecklistItems({
            runtimeStatus: status,
            currentRelayUrl: 'https://cloud.example.test',
            currentShareableUrl: 'https://relay.example.test',
        });

        expect(items).toHaveLength(3);
        const tailscale = items.find((item) => item.id === 'enableSecureAccess');
        expect(tailscale).toMatchObject({
            satisfied: true,
            disabled: true,
            defaultSelected: false,
        });
    });
});
