import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertServerProfile, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveBugReportAccountIdForServer } from './bugReportSessionTarget';

const credentials = vi.hoisted(() => vi.fn());
vi.mock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentialsForServerUrl: credentials } }));

describe('bug report account capture', () => {
    let targetServerId = '';
    beforeEach(() => {
        credentials.mockReset();
        targetServerId = upsertServerProfile({ name: 'Target', serverUrl: 'https://bug-report.example.test' }).id;
    });
    afterEach(() => removeServerProfile(targetServerId));

    it('captures the account from credentials belonging to the selected Home', async () => {
        credentials.mockResolvedValue({ token: 'header.eyJzdWIiOiJzZWxlY3RlZC1hY2NvdW50In0=.signature', secret: 'secret' });
        expect(await resolveBugReportAccountIdForServer(targetServerId)).toBe('selected-account');
        expect(credentials).toHaveBeenCalledWith('https://bug-report.example.test', { serverId: targetServerId });
    });

    it('keeps a report sendable without assuming an account when credentials are unavailable', async () => {
        credentials.mockResolvedValue(null);
        expect(await resolveBugReportAccountIdForServer(targetServerId)).toBeNull();
        credentials.mockRejectedValueOnce(new Error('storage unavailable'));
        expect(await resolveBugReportAccountIdForServer(targetServerId)).toBeNull();
    });
});
