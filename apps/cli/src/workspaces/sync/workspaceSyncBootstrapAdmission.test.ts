import { describe, expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';

import { assertWorkspaceSyncRequesterBootstrapSupported } from './workspaceSyncBootstrapAdmission';

describe('workspace Sync requester bootstrap admission', () => {
  it('admits personal signed relationship bootstrap only with the receiving owner Machine admission', () => {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-owner-root', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
      machineId: 'target', custodianAccountId: 'owner', installationId: 'target-installation', actionId: 'projects.open',
      requestId: 'open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'target' }, accountEncryptionMode: 'plain',
    } });
    const admission: SocketRpcMachineAdmissionContextV1 = { actorAccountId: 'owner', custodianAccountId: 'owner',
      machineId: 'source', installationId: 'source-installation', role: 'manage', encryptionMode: 'plain' };
    const personal = { authorization, admission, receivingAccountId: 'owner', ownerKind: 'relationship' as const };
    expect(() => assertWorkspaceSyncRequesterBootstrapSupported(personal)).not.toThrow();
    for (const receivingAccountId of ['foreign-controller-owner', undefined, null]) {
      expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ ...personal, receivingAccountId }))
        .toThrow(expect.objectContaining({ code: 'machine_access_denied' }));
    }
    for (const denied of [undefined, { ...admission, actorAccountId: 'foreign' }, { ...admission, custodianAccountId: 'foreign' },
      { ...admission, role: 'use' as const }]) {
      expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ ...personal, admission: denied }))
        .toThrow(expect.objectContaining({ code: 'workspace_sync_update_required' }));
    }
    expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ ...personal, receivingAccountId: 'foreign-controller-owner',
      admission: { ...admission, role: 'use' } })).toThrow(expect.objectContaining({ code: 'workspace_sync_update_required' }));
    expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ ...personal, authorization: {
      ...authorization, binding: { ...authorization.binding, custodianAccountId: 'foreign' },
    } })).toThrow(expect.objectContaining({ code: 'workspace_sync_update_required' }));
    for (const unsupported of [{ targetReplacement: true }, { materializesRemoteSource: true }]) {
      expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ ...personal, ...unsupported })).not.toThrow();
      expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ ...personal, ownerKind: 'copy_once', ...unsupported }))
        .toThrow(expect.objectContaining({ code: 'workspace_sync_update_required' }));
    }
    expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ authorization, ownerKind: 'copy_once' })).not.toThrow();
    expect(() => assertWorkspaceSyncRequesterBootstrapSupported({ ownerKind: 'relationship' })).not.toThrow();
  });
});
