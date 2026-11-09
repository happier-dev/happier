import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSavedSecretCatalogReferenceV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineConnectorSecretGrantInputV1Schema } from '@happier-dev/deployment-protocol';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { logger } from '@/ui/logger';
import { withReachabilityJoinCredential } from './prepareReachabilityJoinCredential';

afterEach(() => vi.restoreAllMocks());

describe('connector credential cleanup', () => {
  it.each(['result', 'throw'] as const)('preserves the consumer %s when Home grant removal fails and reports only a safe cause', async primaryKind => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const ingress = fixture.context('machines.setup.apply');
    const runtime = await fixture.client.resolveMachineSetupRuntime(ingress);
    if (!runtime || !runtime.isCurrent || !ingress.signal) throw new Error('Expected installed Account custody');
    const accountId = readAccountIdFromToken(runtime.credentials.token);
    if (!accountId) throw new Error('Expected installed Account identity');
    const resourceId = 'cleanup-join-key';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const secret = 'private-cleanup-key-never-logged';
    const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId, encryptionMode: 'plain',
      entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Join key', kind: 'token',
        ownerAccountId: 'another-owner', revision: 3, materialStatus: 'ready',
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
        content: { v: 1, name: 'Join key', kind: 'token', value: secret } }), recipientEnvelope: null,
    }] });
    fixture.setHomeRead(url => new URL(url).pathname === '/v1/account/saved-secrets/resources/materials'
      ? { status: 200, data: materials } : undefined);
    const grantOperations: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const body = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
      grantOperations.push(body.operation);
      expect(JSON.stringify(body)).not.toContain(secret);
      if (body.operation === 'remove') throw Object.assign(new Error(secret), { config: { secret }, code: 'ECONNRESET' });
      if (body.operation !== 'set') throw new Error('Unexpected grant operation');
      return { status: 200, data: { ok: true, grant: body.grant } };
    });
    const warn = vi.spyOn(logger, 'warn');
    const uncertainty = Object.freeze({ ok: false as const, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    const primaryFailure = Object.freeze(Object.assign(new Error('Primary native failure'), { code: 'outcome_unknown' }));
    const execution = withReachabilityJoinCredential({ selection: { provider: { kind: 'builtin', id: 'tailscale' }, config: {},
      credentialRefs: [{ purpose: 'network.join', credentialRef: { kind: 'savedSecret', ref, resourceRevision: 3 } }] },
      target: { serverId: 'srv_home', machineId: fixture.machine.id, installationId: fixture.installation.installationId },
      runtime, machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId }, installationPublicKey: fixture.pair.publicKey,
      // A local same-Account caller supplies its accepted operation; no requester projection is needed.
      context: { operationAcceptance: { operationId: 'cleanup-operation', accept() {} } }, signal: ingress.signal,
      isCurrent: runtime.isCurrent }, async () => {
        if (primaryKind === 'throw') throw primaryFailure;
        return uncertainty;
      });
    if (primaryKind === 'throw') await expect(execution).rejects.toBe(primaryFailure);
    else expect(await execution).toBe(uncertainty);
    expect(grantOperations).toEqual(['set', 'remove']);
    const cleanupWarnings = warn.mock.calls.filter(([message]) => message === '[Machine credential] Home grant cleanup failed');
    expect(cleanupWarnings).toEqual([['[Machine credential] Home grant cleanup failed',
      projectActionFailureCauseV1(Object.assign(new Error(), { code: 'home_unreachable' }), 'machines.credential_cleanup')]]);
    expect(JSON.stringify(cleanupWarnings)).not.toContain(secret);
    expect(cleanupWarnings[0]?.[1]).not.toHaveProperty('stack');
  });
});
