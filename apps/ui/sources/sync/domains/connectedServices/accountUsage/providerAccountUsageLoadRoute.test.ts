import { describe, expect, it, vi } from 'vitest';

import {
    buildProviderAccountUsageScopeKey,
    readProviderAccountUsageSnapshotForMode,
} from './providerAccountUsageLoadRoute';

describe('providerAccountUsageLoadRoute', () => {
    it('uses the plaintext route exclusively when the selected mode returns no snapshot', async () => {
        const readPlain = vi.fn(async () => null);
        const readSealed = vi.fn(async () => ({ ciphertext: 'sealed' }));

        await expect(readProviderAccountUsageSnapshotForMode({
            mode: 'plain',
            readPlain,
            readSealed,
            openSealed: vi.fn(() => ({ id: 'opened' })),
        })).resolves.toBeNull();

        expect(readPlain).toHaveBeenCalledOnce();
        expect(readSealed).not.toHaveBeenCalled();
    });

    it('uses only the sealed route for an e2ee account', async () => {
        const readPlain = vi.fn(async () => ({ id: 'plain' }));
        const sealed = { ciphertext: 'sealed' };
        const opened = { id: 'opened' };
        const readSealed = vi.fn(async () => sealed);
        const openSealed = vi.fn(() => opened);

        await expect(readProviderAccountUsageSnapshotForMode({
            mode: 'e2ee',
            readPlain,
            readSealed,
            openSealed,
        })).resolves.toBe(opened);

        expect(readPlain).not.toHaveBeenCalled();
        expect(readSealed).toHaveBeenCalledOnce();
        expect(openSealed).toHaveBeenCalledWith(sealed);
    });

    it('separates identical credentials across active servers', () => {
        expect(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 1,
            credentialScope: 'same-credentials',
        })).not.toBe(buildProviderAccountUsageScopeKey({
            serverId: 'server-b',
            generation: 1,
            credentialScope: 'same-credentials',
        }));
    });

    it('separates cache scope across generations of the same active server', () => {
        expect(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 1,
            credentialScope: 'same-credentials',
        })).not.toBe(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 2,
            credentialScope: 'same-credentials',
        }));
    });
});
