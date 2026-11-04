import axios from 'axios';
import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { SessionTeamCredentialBindingIntentV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { computeTeamCredentialNativeBindingReadDigestV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createTeamCredentialNativeProviderSourceFixture } from '@/providers/broker/teamCredentialNativeProviderSource.testkit';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';
import { createDaemonSessionTeamCredentialNativeOpen } from './sessionTeamCredentialProviderBindingComposition';
import { materializeSessionTeamCredentialNativeBinding } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

afterEach(() => { vi.restoreAllMocks(); });

it.each([false, true])('borrows an exact confirmed native binding once through guest materialization (local requester retired: %s)', async retiredLocally => {
  const source = await createTeamCredentialNativeProviderSourceFixture();
  try {
    const projection = await source.services.projectModels(source.request);
    if (projection.status !== 'success') throw new Error('Expected actual native source projection');
    const group = projection.groups[0];
    const row = group?.rows[0];
    if (!group?.sourceRevision || !row?.nativeSource || !row.application) throw new Error('Expected actual native model');
    const placeholder = 'native-placeholder';
    const facet = { managedId: 'managed', controllerInstallationId: 'controller-installation',
      guestInstallationId: 'guest-installation', bindingKey: 'binding',
      placeholderRef: createHash('sha256').update(placeholder).digest('base64url'),
      sourceRevision: group.sourceRevision, providerTicket: row.nativeSource.providerTicket };
    // Home HTTP is the boundary. Its model facts come from the actual committed
    // Agent/Provider source producer, not a stubbed catalog or materializer.
    const model = TeamCredentialProviderModelCatalogEntryV1Schema.parse({ selection: { kind: 'team_credential_provider_model',
      resourceId: 'team-resource', teamId: 'team', expectedResourceRevision: 2, deliveryMode: 'vendor-native',
      agentTargetKey: source.agentTargetKey, modelId: row.ref.modelId }, descriptor: row.descriptor,
      application: row.application, sourceFacts: row.sourceFacts, sourceRevision: group.sourceRevision,
      nativeSource: { providerTicket: row.nativeSource.providerTicket }, availability: 'available' });
    const binding = SessionTeamCredentialBindingIntentV1Schema.parse({ v: 1, slot: { kind: 'provider_model' },
      resourceId: 'team-resource', teamId: 'team', expectedResourceRevision: 2, deliveryMode: 'vendor-native', nativeDelivery: facet });
    if (!binding.resourceId) throw new Error('Expected accepted binding');
    const keys = tweetnacl.sign.keyPair();
    let prepared = false;
    let reads = 0;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toBe('https://home.example/v2/teams/team/credential-resources/team-resource/direct-material');
      const request = body as Parameters<typeof computeTeamCredentialNativeBindingReadDigestV1>[0] & { proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      const { proof, ...readBody } = request;
      expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof,
        payload: { version: 1, accountId: 'member', machineId: 'guest', installationId: 'guest-installation',
          nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(readBody) } } })).toBe(true);
      reads++;
      return { status: 200, data: prepared ? { status: 'prepared', binding: facet } : { status: 'ready', binding: facet,
        model, endpoint: row.nativeSource!.endpoint, credentialTransport: row.nativeSource!.credentialTransport, placeholder } };
    });
    // The real Home transport above admits this captured requester and verifies
    // its proof; an old local observation does not replace that admission.
    const memberToken = `fixture.${Buffer.from(JSON.stringify({ sub: 'member' })).toString('base64url')}.fixture`;
    const requester = createInvocationSavedSecretOperationContextV1({
      credentials: { token: memberToken, encryption: null }, serverHttpBaseUrl: 'https://home.example',
      snapshot: { ...source.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(memberToken) },
      isCurrent: async () => !retiredLocally,
    });
    const open = createDaemonSessionTeamCredentialNativeOpen({ machineId: 'guest', accountId: 'member',
      credentials: { token: 'member-token', encryption: null }, serverHttpBaseUrl: 'https://home.example',
      providerSettingsOperationContext: requester,
      installationIdentity: { installationId: 'guest-installation', privateKey: keys.secretKey },
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'guest', serverIdentityId: 'home' }) });
    const input = { consumer: { kind: 'session' as const, sessionId: 'session' }, agentTargetKey: source.agentTargetKey,
      modelId: row.ref.modelId, binding, signal: new AbortController().signal };
    const opened = await open(input);
    expect(opened.placeholder).toBe(placeholder);
    expect(opened.model).toEqual(model);
    const material = await materializeSessionTeamCredentialNativeBinding({
      consumer: input.consumer, row: model, binding, agentId: source.agentId, lease: source.lease,
      materializationBaseDir: source.happyHomeDir, signal: input.signal, opened,
    });
    try {
      expect(material.environmentOverlay).toEqual([{ name: 'RUN_PROVIDER_TOKEN', value: placeholder, source: 'provider' }]);
      expect(reads).toBe(1);
    } finally { await material.cleanup(); }
    const beforeCleanup = reads;
    await opened.cleanup();
    expect(reads).toBe(beforeCleanup);
    prepared = true;
    await expect(open(input)).rejects.toBeInstanceOf(SessionTeamCredentialLaunchUnavailableError);
    const beforeWrongGuest = reads;
    await expect(open({ ...input, binding: { ...binding, nativeDelivery: { ...facet,
      guestInstallationId: 'other-installation' } } })).rejects.toBeInstanceOf(SessionTeamCredentialLaunchUnavailableError);
    expect(reads).toBe(beforeWrongGuest);
  } finally { await source.cleanup(); }
});
