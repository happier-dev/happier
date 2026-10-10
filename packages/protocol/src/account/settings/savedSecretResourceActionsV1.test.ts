import { describe, expect, it } from 'vitest';

import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { formatSharedSavedSecretRefV1 } from './savedSecretReferenceV1.js';
import { NotificationChannelCatalogMutationV1Schema } from './notificationChannelSchemasV1.js';
import {
  SavedSecretResourceEnvelopeRepairInputV1Schema,
  SharedSavedSecretCreateInputV1Schema,
  SharedSavedSecretDeleteInputV1Schema,
  SharedSavedSecretGrantsSetInputV1Schema,
  SharedSavedSecretPromoteInputV1Schema,
  SharedSavedSecretUpdateInputV1Schema,
} from './savedSecretResourceActionsV1.js';

describe('shared Saved Secret complete audience inputs', () => {
  it('admits the actual Notification channel census and atomic signing-reference mutation with the full source capture', () => {
    const resource = { resourceId: 'notification-signing', displayName: 'Webhook signing', kind: 'token',
      encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'Webhook signing', kind: 'token', value: 'private' } } };
    const reference = formatSharedSavedSecretRefV1(resource.resourceId);
    const domain = NotificationChannelCatalogMutationV1Schema.safeParse({ expectedRevision: 3,
      content: { t: 'plain', v: { v: 1, channels: [{ v: 1, id: 'webhook', kind: 'webhook',
        url: 'https://example.test/notifications', topics: {}, signingSecretRef: reference }] } },
      savedSecretRevisions: [{ resourceRef: reference, revision: 1 }] });
    expect(domain.success).toBe(true);
    if (!domain.success) throw new Error('invalid_actual_notification_mutation_fixture');
    const notificationChannels = { revision: 3, resourceRefs: [reference] };
    const referenceCensus = { accountMode: 'plain', profiles: { referenceGuardRevision: 4,
      rows: [{ id: 'captured-profile', revision: 2 }] }, notificationChannels };
    const deletion = { resourceId: resource.resourceId, expectedRevision: 1, expectedSettingsVersion: 7, referenceCensus };
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse(deletion).success).toBe(true);
    const request = { ...resource, expectedSettingsVersion: 7, nextSettings: { t: 'plain', v: {} },
      referenceCensus, notificationChannelMutation: domain.data };
    const admitted = SharedSavedSecretPromoteInputV1Schema.safeParse(request);
    expect(admitted.success).toBe(true);
    if (admitted.success) {
      expect(admitted.data.referenceCensus).toEqual(referenceCensus);
      expect(admitted.data).toHaveProperty('notificationChannelMutation', domain.data);
    }
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...request,
      notificationChannelMutation: { ...domain.data, expectedRevision: 2 },
    }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...request, expectedSettingsVersion: undefined }).success).toBe(false);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ ...deletion, referenceCensus: {
      ...referenceCensus, notificationChannels: { ...notificationChannels, resourceRefs: ['personal-not-a-resource'] },
    } }).success).toBe(false);
  });

  it.each(['plain', 'e2ee'] as const)('admits a numeric destination-only Notification channel mutation in %s without Profile or Settings facts', (mode) => {
    const resource = { resourceId: 'notification-destination', displayName: 'Webhook signing', kind: 'token',
      encryptionMode: mode, storedContent: mode === 'plain'
        ? { t: 'plain', v: { v: 1, name: 'Webhook signing', kind: 'token', value: 'private' } }
        : { t: 'encrypted', c: Buffer.alloc(40).toString('base64') } };
    const reference = formatSharedSavedSecretRefV1(resource.resourceId);
    const domain = NotificationChannelCatalogMutationV1Schema.safeParse({ expectedRevision: 3,
      content: mode === 'plain'
        ? { t: 'plain', v: { v: 1, channels: [{ v: 1, id: 'webhook', kind: 'webhook',
          url: 'https://example.test/notifications', topics: {}, signingSecretRef: reference }] } }
        : { t: 'encrypted', c: 'opaque-notification-catalog' },
      savedSecretRevisions: [{ resourceRef: reference, revision: 1 }] });
    expect(domain.success).toBe(true);
    if (!domain.success) throw new Error('invalid_actual_notification_mutation_fixture');
    const capture = { revision: 3, resourceRefs: [reference] };
    const request = { ...resource, nextSettings: null,
      referenceCensus: { scope: 'catalogs', accountMode: mode, catalogs: {}, notificationChannels: capture },
      notificationChannelMutation: domain.data };
    const admitted = SharedSavedSecretPromoteInputV1Schema.safeParse(request);
    expect(admitted.success).toBe(true);
    if (admitted.success) {
      expect(admitted.data.referenceCensus).toEqual(request.referenceCensus);
      expect(admitted.data).toHaveProperty('notificationChannelMutation', domain.data);
      expect(admitted.data).not.toHaveProperty('expectedSettingsVersion');
    }
    for (const invalid of [
      { ...request, nextSettings: { t: 'plain', v: {} } },
      { ...request, profileMutations: [{ id: 'profile-a', operation: 'remove', expectedRevision: 1, content: null }] },
      { ...request, notificationChannelMutation: undefined },
      { ...request, notificationChannelMutation: { ...domain.data, expectedRevision: 2 } },
      { ...request, notificationChannelMutation: { ...domain.data, sourceSettingsVersion: 7 } },
      { ...request, referenceCensus: { ...request.referenceCensus, notificationChannels: undefined } },
      { ...request, referenceCensus: { ...request.referenceCensus, catalogs: { acp: 2 } } },
      { ...request, referenceCensus: { ...request.referenceCensus, notificationChannels: { revision: 'absent', resourceRefs: [] } },
        notificationChannelMutation: { ...domain.data, expectedRevision: 'absent', sourceSettingsVersion: 7 } },
    ]) expect(SharedSavedSecretPromoteInputV1Schema.safeParse(invalid).success).toBe(false);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ resourceId: resource.resourceId, expectedRevision: 1,
      expectedSettingsVersion: 7, referenceCensus: request.referenceCensus,
    }).success).toBe(false);
  });

  it.each(['personal-primary', 'happier:shared-secret:v1:existing-resource'])('binds opaque personal source %s only to the resources in that composite request', personalSecretId => {
    const resource = { resourceId: 'promotion-primary', displayName: 'Token', kind: 'token', encryptionMode: 'plain',
      storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } } };
    const request = { ...resource, expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: {} },
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
      personalSecretPromotions: [{ personalSecretId, resourceId: resource.resourceId },
        { personalSecretId: 'personal-secondary', resourceId: 'promotion-secondary' }],
      additionalSavedSecretResources: [{ ...resource, resourceId: 'promotion-secondary' }] };
    const parsed = SharedSavedSecretPromoteInputV1Schema.safeParse(request);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toHaveProperty('personalSecretPromotions', request.personalSecretPromotions);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...request,
      personalSecretPromotions: [{ personalSecretId: 'personal-primary', resourceId: 'not-in-request' }],
    }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...request,
      personalSecretPromotions: [request.personalSecretPromotions[0], request.personalSecretPromotions[0]],
    }).success).toBe(false);
    expect(SharedSavedSecretCreateInputV1Schema.safeParse({ ...resource,
      personalSecretPromotions: request.personalSecretPromotions,
    }).success).toBe(false);
  });

  it('admits the actual Remote Host census and its atomic SSH credential mutation without dropping either capture', () => {
    const resource = { resourceId: 'ssh-password', displayName: 'SSH password', kind: 'password',
      encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'private' } } };
    const reference = formatSharedSavedSecretRefV1(resource.resourceId);
    const remoteHosts = { revision: 3, resourceRefs: [reference] };
    const referenceCensus = { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] }, remoteHosts };
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ resourceId: resource.resourceId,
      expectedRevision: 1, expectedSettingsVersion: 7, referenceCensus,
    }).success).toBe(true);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ resourceId: resource.resourceId,
      expectedRevision: 1, expectedSettingsVersion: 7, referenceCensus: {
        ...referenceCensus, remoteHosts: { ...remoteHosts, resourceRefs: ['personal-not-a-resource'] },
      },
    }).success).toBe(false);
    const mutation = { expectedRevision: 3, content: { t: 'plain', v: { v: 1, hosts: [{
      id: 'host', name: 'Host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
      ssh: { target: 'user@example.test', authMode: 'password', passwordSecretRef: reference },
    }] } }, referencedSavedSecretRevisions: [{ resourceId: resource.resourceId, revision: 1 }] };
    const request = { ...resource, expectedSettingsVersion: 7, nextSettings: { t: 'plain', v: {} },
      referenceCensus, remoteHostMutation: mutation };
    const admitted = SharedSavedSecretPromoteInputV1Schema.safeParse(request);
    expect(admitted.success).toBe(true);
    if (admitted.success) {
      expect(admitted.data.referenceCensus).toEqual(referenceCensus);
      expect(admitted.data).toHaveProperty('remoteHostMutation', mutation);
    }
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...request,
      remoteHostMutation: { ...mutation, expectedRevision: 2 },
    }).success).toBe(false);
    const destinationOnly = { ...resource, nextSettings: null,
      referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: {}, remoteHosts },
      remoteHostMutation: mutation };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse(destinationOnly).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...destinationOnly,
      remoteHostMutation: { ...mutation, sourceSettingsVersion: 7 },
    }).success).toBe(false);
    const initialHost = { ...destinationOnly,
      referenceCensus: { ...destinationOnly.referenceCensus, remoteHosts: { revision: 'absent', resourceRefs: [] } },
      remoteHostMutation: { ...mutation, expectedRevision: 'absent', sourceSettingsVersion: 7 },
    };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse(initialHost).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...initialHost,
      remoteHostMutation: { ...initialHost.remoteHostMutation, sourceSettingsVersion: undefined },
    }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...initialHost,
      referenceCensus: { ...initialHost.referenceCensus, remoteHosts: undefined },
    }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...destinationOnly, remoteHostMutation: undefined }).success).toBe(false);
  });

  it('admits all five captured catalog authorities and rejects an incomplete catalog census', () => {
    const base = { resourceId: 'captured-catalogs', expectedRevision: 1, expectedSettingsVersion: 4,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
        catalogs: { mcp: 2, acp: 'absent', providerConnections: 4,
          connectedConfigurations: 0, connectedPurposes: 3 } } };
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse(base).success).toBe(true);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ ...base, referenceCensus: {
      ...base.referenceCensus, catalogs: { mcp: 2 },
    } }).success).toBe(false);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ ...base, referenceCensus: {
      ...base.referenceCensus, catalogs: { ...base.referenceCensus.catalogs, mcp: -1 },
    } }).success).toBe(false);
  });

  it('admits one atomic batch of new resources and typed ACP reference mutation', () => {
    const resource = { resourceId: 'batch-primary', displayName: 'First', kind: 'token',
      encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'First', kind: 'token', value: 'private' } } };
    const request = { ...resource, expectedSettingsVersion: 4, nextSettings: null,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
        catalogs: { mcp: 'absent', acp: 1, providerConnections: 'absent',
          connectedConfigurations: 'absent', connectedPurposes: 'absent' } },
      additionalSavedSecretResources: [{ ...resource, resourceId: 'batch-secondary' }],
      catalogMutations: { acp: { expectedRevision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
        referencedSavedSecretIds: [], savedSecretRevisions: [] } } };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse(request).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...request,
      additionalSavedSecretResources: [resource],
    }).success).toBe(false);
  });

  it('keeps paired Settings writes at the outer resource owner and catalog captures at their exact arm', () => {
    const base = { resourceId: 'paired-catalog', displayName: 'Token', kind: 'token', encryptionMode: 'plain',
      storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } },
      expectedSettingsVersion: 4, nextSettings: null,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
        catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent',
          connectedConfigurations: 1, connectedPurposes: 2 } },
      catalogMutations: { connectedPurposes: { expectedRevision: 2,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } },
        referencedSavedSecretIds: [], savedSecretRevisions: [] } } };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse(base).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, catalogMutations: {
      connectedPurposes: { ...base.catalogMutations.connectedPurposes,
        settingsMutation: { expectedSettingsVersion: 4, content: { t: 'plain', v: {} } } },
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, catalogMutations: {
      connectedConfigurations: base.catalogMutations.connectedPurposes,
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, catalogMutations: {
      connectedPurposes: { ...base.catalogMutations.connectedPurposes, expectedRevision: 1 },
    } }).success).toBe(false);
  });

  it('admits an honest destination-only catalog census without fabricated Profile or Settings proofs', () => {
    const base = { resourceId: 'catalog-only', displayName: 'Token', kind: 'token', encryptionMode: 'plain',
      storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } }, nextSettings: null,
      referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: { acp: 2 } },
      catalogMutations: { acp: { expectedRevision: 2, content: { t: 'plain', v: { v: 1, definitions: [] } },
        referencedSavedSecretIds: [], savedSecretRevisions: [] } } };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse(base).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, nextSettings: { t: 'plain', v: {} } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, referenceCensus: {
      ...base.referenceCensus, catalogs: { acp: 2, mcp: 3 },
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, catalogMutations: {
      acp: { ...base.catalogMutations.acp, expectedRevision: 'absent', sourceSettingsVersion: 4, source: 'fresh' },
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, catalogMutations: {} }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, referenceCensus: {
      ...base.referenceCensus, catalogs: {},
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, catalogMutations: {
      acp: { ...base.catalogMutations.acp, expectedRevision: 1 },
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, catalogMutations: {
      acp: { ...base.catalogMutations.acp, sourceSettingsVersion: 4 },
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, profileMutations: [{
      id: 'profile-a', operation: 'remove', expectedRevision: 1, content: null,
    }] }).success).toBe(false);
    // Destination-only admission has no authority to rewrite retained personal
    // source references, including the reached Machine/preset source carriers.
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base,
      personalSecretPromotions: [{ personalSecretId: 'retained-personal', resourceId: base.resourceId }],
    }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, personalSecretPromotions: [] }).success).toBe(true);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ resourceId: base.resourceId, expectedRevision: 1,
      expectedSettingsVersion: 4, referenceCensus: base.referenceCensus,
    }).success).toBe(false);
  });

  it('admits the five existing encrypted catalog mutation arms with exactly their captured revisions', () => {
    const mutation = { expectedRevision: 2, content: { t: 'encrypted', c: 'opaque-catalog' },
      referencedSavedSecretIds: [], savedSecretRevisions: [] };
    const base = { resourceId: 'encrypted-catalogs', displayName: 'Token', kind: 'token', encryptionMode: 'e2ee',
      storedContent: { t: 'encrypted', c: Buffer.alloc(40).toString('base64') }, nextSettings: null,
      referenceCensus: { scope: 'catalogs', accountMode: 'e2ee', catalogs: {
        mcp: 2, acp: 2, providerConnections: 2, connectedConfigurations: 2, connectedPurposes: 2,
      } }, catalogMutations: { mcp: mutation, acp: mutation, providerConnections: mutation,
        connectedConfigurations: mutation, connectedPurposes: mutation } };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse(base).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, referenceCensus: {
      ...base.referenceCensus, profiles: { referenceGuardRevision: 'absent', rows: [] },
    } }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, referenceCensus: {
      ...base.referenceCensus, catalogs: { ...base.referenceCensus.catalogs, connectedConfigurations: 1 },
    } }).success).toBe(false);
  });

  it('requires the original Settings capture for a full census and closes catalog mutation routing', () => {
    const base = { resourceId: 'full-capture', displayName: 'Token', kind: 'token', encryptionMode: 'plain',
      storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } }, nextSettings: null,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse(base).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, expectedSettingsVersion: 4 }).success).toBe(true);
    const mutation = { expectedRevision: 2, content: { t: 'plain', v: { v: 1, definitions: [] } },
      referencedSavedSecretIds: [], savedSecretRevisions: [] };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, expectedSettingsVersion: 4,
      catalogMutations: { acp: mutation },
    }).success).toBe(false);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, expectedSettingsVersion: 4,
      catalogMutations: { unknownCatalog: mutation },
    }).success).toBe(false);
    const secondary = { resourceId: 'secondary', displayName: base.displayName, kind: base.kind,
      encryptionMode: base.encryptionMode, storedContent: base.storedContent };
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, expectedSettingsVersion: 4,
      additionalSavedSecretResources: [secondary],
    }).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ ...base, expectedSettingsVersion: 4,
      additionalSavedSecretResources: [secondary, secondary],
    }).success).toBe(false);
  });

  it('admits exact revisions of explicitly reached Profile Artifacts, not an arbitrary catalog claim', () => {
    const base = { resourceId: 'captured-reference', expectedRevision: 1, expectedSettingsVersion: 4,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 7, rows: [{ id: 'profile-a', revision: 3 }] },
        artifacts: [{ artifactId: 'selected-foreign-profile', headerVersion: 2, bodyVersion: 4 }] } };
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse(base).success).toBe(true);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({ ...base, referenceCensus: {
      ...base.referenceCensus, artifacts: [base.referenceCensus.artifacts[0], base.referenceCensus.artifacts[0]],
    } }).success).toBe(false);
  });

  it('captures the incumbent Profile transfer control revision for source-sensitive composite writes', () => {
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({ resourceId: 'source-promotion', displayName: 'Token', kind: 'token',
      encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } },
      expectedSettingsVersion: 4, nextSettings: { t: 'plain', v: {} }, profileMutations: [],
      referenceCensus: { accountMode: 'plain', profileTransferRevision: 0,
        profiles: { referenceGuardRevision: 7, rows: [{ id: 'profile-a', revision: 3 }] } },
    }).success).toBe(true);
  });

  it('admits a captured private Profile reference census and rejects uncaptured deletion', () => {
    const base = { resourceId: 'captured-reference', expectedRevision: 1, expectedSettingsVersion: 4 };
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({
      ...base,
      referenceCensus: {
        accountMode: 'plain',
        profiles: { referenceGuardRevision: 7, rows: [{ id: 'profile-a', revision: 3 }] },
      },
    }).success).toBe(true);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse(base).success).toBe(false);
  });

  it('accepts 257 structurally valid grants and envelopes without a semantic collection cap', () => {
    const ids = Array.from({ length: 257 }, (_, index) => `subject-${index}`);
    const encryptedDataKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES).toString('base64');
    const keyEnvelopes = ids.map((recipientAccountId) => ({
      recipientAccountId,
      encryptedDataKey,
      recipientContentPublicKeyFingerprint: `fingerprint-${recipientAccountId}`,
    }));
    const createInput = {
      resourceId: 'resource-257',
      displayName: 'Complete audience',
      kind: 'token' as const,
      encryptionMode: 'e2ee' as const,
      storedContent: { t: 'encrypted' as const, c: Buffer.alloc(40).toString('base64') },
      accountGrants: ids,
      teamGrants: ids,
      groupGrants: ids,
      keyEnvelopes,
    };

    expect(SharedSavedSecretCreateInputV1Schema.safeParse(createInput).success).toBe(true);
    expect(SharedSavedSecretPromoteInputV1Schema.safeParse({
      ...createInput,
      expectedSettingsVersion: 1,
      nextSettings: null,
      referenceCensus: { accountMode: 'e2ee', profiles: { referenceGuardRevision: 'absent', rows: [] } },
    }).success).toBe(true);
    expect(SharedSavedSecretGrantsSetInputV1Schema.safeParse({
      resourceId: createInput.resourceId,
      expectedRevision: 1,
      accountGrants: ids,
      teamGrants: ids,
      groupGrants: ids,
      keyEnvelopes,
    }).success).toBe(true);
    expect(SavedSecretResourceEnvelopeRepairInputV1Schema.safeParse({
      resourceId: createInput.resourceId,
      expectedRevision: 1,
      keyEnvelopes,
    }).success).toBe(true);
  });

  it('retains structural validation for entries in uncapped complete arrays', () => {
    expect(SharedSavedSecretGrantsSetInputV1Schema.safeParse({
      resourceId: 'resource-structural-check',
      expectedRevision: 1,
      accountGrants: [''],
      teamGrants: [],
      groupGrants: [],
    }).success).toBe(false);
  });

  it('accepts an opaque retained identity for the existing delete recovery action', () => {
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({
      resourceId: ` ${'retained-corrupt-id'.repeat(10)}`,
      expectedRevision: -4,
      expectedSettingsVersion: 1,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
    }).success).toBe(true);
    expect(SharedSavedSecretDeleteInputV1Schema.safeParse({
      resourceId: '',
      expectedRevision: -4,
      expectedSettingsVersion: 1,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
    }).success).toBe(true);
  });

  // Plan 10.08 §10.5/§11.0: an explicit mode conversion is an arm of the one
  // update intent, not a separate Action.
  it('carries an explicit mode conversion on the existing update input', () => {
    const encryptedDataKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES).toString('base64');
    const base = {
      resourceId: 'resource-convert',
      expectedRevision: 3,
      displayName: 'Shared token',
      kind: 'token' as const,
      storedContent: { t: 'encrypted' as const, c: Buffer.alloc(40).toString('base64') },
    };

    expect(SharedSavedSecretUpdateInputV1Schema.safeParse(base).success).toBe(true);
    expect(SharedSavedSecretUpdateInputV1Schema.safeParse({
      ...base,
      toMode: 'e2ee',
      keyEnvelopes: [{
        recipientAccountId: 'owner-a',
        encryptedDataKey,
        recipientContentPublicKeyFingerprint: 'fingerprint-owner-a',
      }],
    }).success).toBe(true);
    expect(SharedSavedSecretUpdateInputV1Schema.safeParse({
      ...base,
      toMode: 'plain',
      storedContent: { t: 'plain', v: { v: 1, name: 'Shared token', kind: 'token', value: 'value' } },
    }).success).toBe(true);
    expect(SharedSavedSecretUpdateInputV1Schema.safeParse({ ...base, toMode: 'managed' }).success).toBe(false);
    expect(SharedSavedSecretUpdateInputV1Schema.safeParse({ ...base, encryptionMode: 'plain' }).success).toBe(false);
  });
});
