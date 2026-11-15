import { afterEach, expect, it } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { bindAccountEncryptionObservation, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { resetAccountSettingsRawSnapshotsForTests, retainAccountSettingsRawSnapshot } from './accountSettingsRawSnapshot';
import { normalizeAccountSettingsHistoryAfterTransfer } from './accountSettingsHistoryRestore';

const credentials = { token: 'history-on-change-token' };

/**
 * Owner ruling 2026-11-15 ("Settings-history normalization runs only on change"): a catalog load runs
 * normalization only after a Settings write this client has observed (its own, or one pushed to it) or
 * when one of its catalog roots is newly active. A load with nothing new makes 0 requests.
 */
it('normalizes once per Settings write or newly active root, and a repeated catalog load makes no request', async () => {
    let head = 5;
    const requests: string[] = [];
    // The Home HTTP transport is the boundary; the live Account observation says the retained head is current.
    const request = bindAccountEncryptionObservation(async (path: string) => {
        requests.push(path);
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: head }));
        if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        throw new Error(`Unexpected request ${path}`);
    }, { credentials, credentialScopeKey: resolveAuthCredentialsScopeKey(credentials), isCurrent: () => true } as AccountEncryptionObservationBinding);
    const settingsScope = { serverId: 'history-on-change-home', accountId: 'owner' };
    const load = (roots: readonly string[]) => normalizeAccountSettingsHistoryAfterTransfer({
        credentials, encryption: null, settingsScope, destinationAuthority: { activeTransferredRoots: [...roots] },
        requestContext: { request: request as never, isCurrent: () => true },
    });
    const count = async (roots: readonly string[]) => {
        requests.length = 0;
        expect(await load(roots)).toEqual({ status: 'complete' });
        return requests.length;
    };
    retainAccountSettingsRawSnapshot(settingsScope, head, {});

    expect(await count(['mcpServersSettingsV1'])).toBeGreaterThan(0);
    // Same head, same active roots: nothing new to normalize.
    expect(await count(['mcpServersSettingsV1'])).toBe(0);
    // A catalog root that became active since the last pass runs it once.
    expect(await count(['notificationChannelsV1'])).toBeGreaterThan(0);
    expect(await count(['notificationChannelsV1'])).toBe(0);
    expect(await count(['mcpServersSettingsV1'])).toBe(0);
    // A Settings write (local, or pushed and admitted) moves the retained head: one pass, then quiet.
    head = 6;
    retainAccountSettingsRawSnapshot(settingsScope, head, {});
    expect(await count(['mcpServersSettingsV1'])).toBeGreaterThan(0);
    expect(await count(['mcpServersSettingsV1'])).toBe(0);
    // Saved Secret recovery inputs (Notifications, Remote hosts) are part of what a pass decided: the same
    // resource revisions at the same head make no request; a changed revision runs once.
    const recovery = (revision: number) => ({ accountId: 'owner', source: { raw: {}, version: head },
        resources: [{ resourceId: 'secret-1', ownerAccountId: 'owner', revision, materialStatus: 'ready' as const }] });
    const withRecovery = async (revision: number) => {
        requests.length = 0;
        expect(await normalizeAccountSettingsHistoryAfterTransfer({
            credentials, encryption: null, settingsScope, destinationAuthority: { activeTransferredRoots: ['notificationChannelsV1'] },
            savedSecretRecovery: recovery(revision) as never, requestContext: { request: request as never, isCurrent: () => true },
        })).toEqual({ status: 'complete' });
        return requests.length;
    };
    expect(await withRecovery(1)).toBeGreaterThan(0);
    expect(await withRecovery(1)).toBe(0);
    expect(await withRecovery(2)).toBeGreaterThan(0);
    expect(await withRecovery(2)).toBe(0);
});

afterEach(() => resetAccountSettingsRawSnapshotsForTests());
