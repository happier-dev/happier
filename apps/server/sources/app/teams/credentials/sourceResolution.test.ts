import { describe, expect, it } from 'vitest';
import { CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { projectConnectedAccountSourceResolution, projectConnectedPoolSourceResolution } from './sourceResolution';

const service = { pluginId: 'test.connected-account', localId: 'subscription' };
const account = { service, accountId: 'personal' };
const failure = { code: 'access_only_expiry_unavailable' as const, message: 'Reconnect with the source owner.' };
const identity = { incarnation: 'credential', credentialRevision: 'revision', configurationRevision: null,
    authenticationModeId: 'import', status: 'connected' as const,
    directExportContract: CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1,
    contributionContractVersion: 'contribution', directExportFailure: failure };

describe('source-owned direct export availability', () => {
    it('preserves the declaration and personal authentication while projecting the export refusal', () => {
        expect(projectConnectedAccountSourceResolution({ v: 1, kind: 'connected_account',
            target: { kind: 'account', account }, credentialIncarnation: 'credential' }, identity))
            .toMatchObject({ status: 'current', directExportSupport: 'supported', directExportFailure: failure });
    });

    it('refuses a Pool only when every enabled member reports the refusal', () => {
        const source = { v: 1 as const, kind: 'connected_pool' as const,
            target: { kind: 'group' as const, service, groupId: 'pool' }, poolIncarnation: 'pool-life' };
        const member = { ...identity, account, credentialIncarnation: 'credential', priority: 0, enabled: true };
        const snapshot = { incarnation: 'pool-life', generation: 0, runtimeStateRevision: 0,
            activeConnectedAccountId: 'personal', members: [member] };
        expect(projectConnectedPoolSourceResolution(source, snapshot)).toMatchObject({ directExportFailure: failure });
        expect(projectConnectedPoolSourceResolution(source, { ...snapshot,
            members: [member, { ...member, account: { service, accountId: 'unsupported' },
                directExportContract: null, directExportFailure: undefined }] }))
            .toMatchObject({ directExportFailure: failure });
        expect(projectConnectedPoolSourceResolution(source, { ...snapshot,
            members: [member, { ...member, account: { service, accountId: 'working' }, directExportFailure: undefined }] }))
            .not.toHaveProperty('directExportFailure');
    });
});
