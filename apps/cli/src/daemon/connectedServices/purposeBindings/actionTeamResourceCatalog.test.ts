import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { listConnectedAccountActionFormOptions } from '@happier-dev/cli-common/connectedAccounts';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { TeamCredentialResourceCatalogEntryV1Schema, teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams/capabilities';
import { createCliPrivateLabelActionOpener } from '@/api/privateLabels';
import { createConnectedAccountActionTeamResourceCatalogReader } from './actionTeamResourceCatalog';

describe('optional Action Team catalog', () => {
  it.each(['teams_unavailable', 'feature_disabled', 'unsupported_action'])('preserves personal discovery when the Home reports %s', async code => {
    const read = createConnectedAccountActionTeamResourceCatalogReader({
      privateLabelOpen: createCliPrivateLabelActionOpener(null),
      homeDomainAction: async () => ({ ok: false, errorCode: code, error: code }),
    });
    await expect(read(new AbortController().signal)).resolves.toEqual([]);
  });
  it('keeps authorization refusals visible', async () => {
    const read = createConnectedAccountActionTeamResourceCatalogReader({
      privateLabelOpen: createCliPrivateLabelActionOpener(null),
      homeDomainAction: async () => ({ ok: false, errorCode: 'team_forbidden', error: 'team_forbidden' }),
    });
    await expect(read(new AbortController().signal)).rejects.toBeInstanceOf(Error);
  });
});

it.each(['plain', 'e2ee', 'unavailable'] as const)('opens %s recipient labels before the actual purpose inventory projection', async mode => {
  const service = { pluginId: 'acme.cloud', localId: 'cloud-account' };
  const resourceId = 'shared-cloud';
  const accountKey = new Uint8Array(32).fill(8);
  const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
  const dataKey = new Uint8Array(32).fill(13);
  const binding = teamCredentialDisplayNamePrivateLabelBindingV1(resourceId);
  const stored = mode === 'plain' ? sealPrivateLabelV1({ mode, binding, value: 'Shared cloud' })
    : sealPrivateLabelV1({ mode: 'e2ee', binding, value: 'Shared cloud', dataKey,
      recipients: [{ accountId: 'recipient', envelope: {
        encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: publicKey,
          randomBytes: length => new Uint8Array(length).fill(17) })),
        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey),
      } }], randomBytes: length => new Uint8Array(length).fill(19) });
  const label = projectPrivateLabelForRecipientV1({ stored, recipientAccountId: mode === 'unavailable' ? 'foreign' : 'recipient' });
  const selection = { source: 'team_resource' as const, resourceId, deliveryMode: 'brokered' as const };
  const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: resourceId, teamId: 'team-a', displayName: label,
    resourceRevision: 1, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
    directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
    connectedServiceSelections: [selection], sourcePresentation: { kind: 'connected_service', service } });
  // Authenticated Home catalog transport is the boundary; catalog, crypto and purpose projection owners stay real.
  const read = createConnectedAccountActionTeamResourceCatalogReader({
    privateLabelOpen: createCliPrivateLabelActionOpener(mode === 'plain' ? null : { type: 'dataKey', machineKey: accountKey, publicKey }),
    homeDomainAction: async request => request.actionId === 'teams.list' ? { items: [{
      id: 'team-a', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
      policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null },
      viewerRole: 'member', capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
      admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } }, counts: null,
    }], nextCursor: null } : { resources: [resource], nextCursor: null },
  });
  const options = await listConnectedAccountActionFormOptions({ available: false,
    resolveService: async () => null, listAccounts: async () => [], listTeamResources: read,
  }, { serviceRefs: [service], signal: new AbortController().signal });
  expect(options).toEqual([{ value: { teamId: 'team-a', selection }, label: mode === 'unavailable' ? resourceId : 'Shared cloud' }]);
});
