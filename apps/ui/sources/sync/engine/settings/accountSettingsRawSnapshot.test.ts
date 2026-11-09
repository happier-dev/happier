import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { bindAccountEncryptionObservation, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import {
    markAccountSettingsHeadUnverified,
    readCurrentAccountSettingsRawSnapshot,
    resetAccountSettingsRawSnapshotsForTests,
    retainAccountSettingsRawSnapshot,
} from './accountSettingsRawSnapshot';

const scope = { serverId: 'home', accountId: 'owner' };
const credentials = { token: 'owner-token' };

function liveObservationPorts(head: () => number) {
    const probes = vi.fn();
    const request = bindAccountEncryptionObservation(async (path: string) => {
        if (path !== '/v1/account/encryption/currentness') throw new Error(`Unexpected request: ${path}`);
        probes();
        return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: head() }));
    }, {
        credentials, credentialScopeKey: resolveAuthCredentialsScopeKey(credentials),
        isCurrent: () => true,
    } as AccountEncryptionObservationBinding);
    const readBaseline = vi.fn(async () => ({ raw: { fromBaseline: true }, version: head() }));
    return { probes, readBaseline, ports: { credentials, request, readBaseline } };
}

describe('current Account Settings document owner', () => {
    afterEach(() => resetAccountSettingsRawSnapshotsForTests());

    it('reuses the delivered document without a probe while the observation has had no gap', async () => {
        retainAccountSettingsRawSnapshot(scope, 5, { delivered: true });
        const { probes, readBaseline, ports } = liveObservationPorts(() => 6);
        expect(await readCurrentAccountSettingsRawSnapshot(scope, ports)).toMatchObject({ version: 5, raw: { delivered: true } });
        expect(probes).toHaveBeenCalledTimes(0);
        expect(readBaseline).toHaveBeenCalledTimes(0);
    });

    it('probes once after a gap and keeps the document when the head did not move', async () => {
        retainAccountSettingsRawSnapshot(scope, 5, { delivered: true });
        const { probes, readBaseline, ports } = liveObservationPorts(() => 5);
        markAccountSettingsHeadUnverified();
        await readCurrentAccountSettingsRawSnapshot(scope, ports);
        await readCurrentAccountSettingsRawSnapshot(scope, ports);
        expect(probes).toHaveBeenCalledTimes(1);
        expect(readBaseline).toHaveBeenCalledTimes(0);
    });

    it('reads a write missed during a gap instead of serving the stale document', async () => {
        retainAccountSettingsRawSnapshot(scope, 5, { delivered: true });
        const { probes, readBaseline, ports } = liveObservationPorts(() => 6);
        markAccountSettingsHeadUnverified();
        expect(await readCurrentAccountSettingsRawSnapshot(scope, ports)).toMatchObject({ version: 6, raw: { fromBaseline: true } });
        expect(await readCurrentAccountSettingsRawSnapshot(scope, ports)).toMatchObject({ version: 6 });
        expect(probes).toHaveBeenCalledTimes(1);
        expect(readBaseline).toHaveBeenCalledTimes(1);
    });
});
