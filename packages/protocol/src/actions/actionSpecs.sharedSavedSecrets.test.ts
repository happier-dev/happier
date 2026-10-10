import { describe, expect, it } from 'vitest';

import {
  SHARED_SAVED_SECRET_ACTION_IDS_V1,
  SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1,
  SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
  SHARED_SAVED_SECRET_ACTION_PATHS_V1,
} from '../account/settings/savedSecretResourceActionsV1.js';
import { ActionIdSchema } from './actionIds.js';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { getActionSpec, listActionSpecs } from './actionSpecs.js';
import { bindHomeDomainActionHttpRequestV1 } from './homeDomainActionFamily.js';

describe('Shared Saved Secret Action contracts', () => {
  it('declares canonical approval behavior for the complete action family', () => {
    const expectedApprovalByActionId = {
      'secrets.shared.list': { result: 'required' },
      'secrets.shared.create': { result: 'required', flow: 'deferred' },
      'secrets.shared.promote': { result: 'required', flow: 'deferred' },
      'secrets.shared.grants.set': { result: 'required', flow: 'deferred' },
      'secrets.shared.update': { result: 'required', flow: 'deferred' },
      'secrets.shared.delete': { result: 'required', flow: 'deferred' },
    } as const;

    expect(Object.keys(expectedApprovalByActionId)).toEqual(SHARED_SAVED_SECRET_ACTION_IDS_V1);
    for (const actionId of SHARED_SAVED_SECRET_ACTION_IDS_V1) {
      expect(getActionSpec(actionId).approval, actionId).toEqual(expectedApprovalByActionId[actionId]);
    }
  });

  it('registers every user intent once through its real Home route', () => {
    expect(SHARED_SAVED_SECRET_ACTION_IDS_V1).toEqual([
      'secrets.shared.list',
      'secrets.shared.create',
      'secrets.shared.promote',
      'secrets.shared.grants.set',
      'secrets.shared.update',
      'secrets.shared.delete',
    ]);
    for (const id of SHARED_SAVED_SECRET_ACTION_IDS_V1) {
      expect(ActionIdSchema.parse(id)).toBe(id);
      expect(listActionSpecs().filter((spec) => spec.id === id)).toHaveLength(1);
      const spec = getActionSpec(id);
      expect(spec.inputSchema).toBe(SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[id]);
      expect(spec.outputSchema).toBe(SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[id]);
      expect(spec.executionPlacement).toBe('account');
      expect(spec.serverTransport?.path).toBe(SHARED_SAVED_SECRET_ACTION_PATHS_V1[id]);
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, api: true, plugin: true });
      const exposedOnMcp = id === 'secrets.shared.promote' || id === 'secrets.shared.grants.set';
      expect(spec.surfaces.mcp).toBe(exposedOnMcp);
      expect(spec.bindings?.mcpToolName).toBe(exposedOnMcp ? id.replaceAll('.', '_') : undefined);
      expect(spec.approval).toEqual(id === 'secrets.shared.list'
        ? { result: 'required' }
        : { result: 'required', flow: 'deferred' });
    }
  });

  it('binds raw V1 list and mutation requests from the source-owned row', () => {
    expect(bindHomeDomainActionHttpRequestV1('secrets.shared.list', {})).toEqual({
      method: 'GET',
      path: '/v1/account/saved-secrets/resources',
      body: undefined,
    });
    expect(bindHomeDomainActionHttpRequestV1('secrets.shared.grants.set', {
      resourceId: 'secret-1', expectedRevision: 2,
      accountGrants: [], teamGrants: ['team-1'], groupGrants: [],
    })).toEqual({
      method: 'POST',
      path: '/v1/account/saved-secrets/resources/grants',
      body: {
        resourceId: 'secret-1', expectedRevision: 2,
        accountGrants: [], teamGrants: ['team-1'], groupGrants: [],
      },
    });
  });

  it('carries structurally valid current recipient envelopes inside the atomic access intent', () => {
    const envelope = {
      recipientAccountId: 'account-2',
      encryptedDataKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES).toString('base64'),
      recipientContentPublicKeyFingerprint: 'content-key:v1:account-2',
    };
    expect(SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.shared.grants.set'].parse({
      resourceId: 'secret-1', expectedRevision: 2,
      accountGrants: ['account-2'], teamGrants: [], groupGrants: [],
      keyEnvelopes: [envelope],
    }).keyEnvelopes).toEqual([envelope]);
    expect(SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.shared.grants.set'].safeParse({
      resourceId: 'secret-1', expectedRevision: 2,
      accountGrants: [], teamGrants: [], groupGrants: [],
      keyEnvelopes: [{
        ...envelope,
        encryptedDataKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES - 1).toString('base64'),
      }],
    }).success).toBe(false);
  });

  it('projects secret-bearing mutation inputs to strict metadata-only observations', () => {
    const storedContent = {
      t: 'encrypted' as const,
      c: Buffer.alloc(40, 7).toString('base64'),
    };
    const keyEnvelope = {
      recipientAccountId: 'account-2',
      encryptedDataKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES).toString('base64'),
      recipientContentPublicKeyFingerprint: 'content-key:v1:account-2',
    };
    const common = {
      resourceId: 'secret-1',
      displayName: 'CI token',
      kind: 'token' as const,
      encryptionMode: 'plain' as const,
      storedContent,
      accountGrants: ['account-2'],
      teamGrants: ['team-1'],
      groupGrants: ['group-1'],
      keyEnvelopes: [keyEnvelope],
    };

    expect(getActionSpec('secrets.shared.create').projectObservationInput?.(common)).toEqual({
      resourceId: 'secret-1',
      displayName: 'CI token',
      kind: 'token',
      encryptionMode: 'plain',
      accountGrants: ['account-2'],
      teamGrants: ['team-1'],
      groupGrants: ['group-1'],
    });
    expect(getActionSpec('secrets.shared.promote').projectObservationInput?.({
      ...common,
      expectedSettingsVersion: 7,
      nextSettings: { t: 'encrypted', c: 'sealed-settings-envelope' },
      referenceCensus: { accountMode: 'e2ee', profiles: { referenceGuardRevision: 0, rows: [] } },
      profileMutations: [],
    })).toEqual({
      resourceId: 'secret-1',
      displayName: 'CI token',
      kind: 'token',
      encryptionMode: 'plain',
      accountGrants: ['account-2'],
      teamGrants: ['team-1'],
      groupGrants: ['group-1'],
      expectedSettingsVersion: 7,
    });
    expect(getActionSpec('secrets.shared.grants.set').projectObservationInput?.({
      resourceId: 'secret-1',
      expectedRevision: 2,
      accountGrants: ['account-2'],
      teamGrants: [],
      groupGrants: [],
      keyEnvelopes: [keyEnvelope],
    })).toEqual({
      resourceId: 'secret-1',
      expectedRevision: 2,
      accountGrants: ['account-2'],
      teamGrants: [],
      groupGrants: [],
    });
    expect(getActionSpec('secrets.shared.update').projectObservationInput?.({
      resourceId: 'secret-1',
      expectedRevision: 3,
      displayName: 'Rotated token',
      kind: 'token',
      storedContent,
    })).toEqual({
      resourceId: 'secret-1',
      expectedRevision: 3,
      displayName: 'Rotated token',
      kind: 'token',
    });
    // A mode conversion is the trust change an approver decides on (plan
    // 10.08 §10.5/§18.3(3)), so the observation names it; the payload and
    // the envelopes stay out.
    expect(getActionSpec('secrets.shared.update').projectObservationInput?.({
      resourceId: 'secret-1',
      expectedRevision: 3,
      displayName: 'Rotated token',
      kind: 'token',
      storedContent: { t: 'plain', v: { v: 1, name: 'Rotated token', kind: 'token', value: 'plain-value' } },
      toMode: 'plain',
    })).toEqual({
      resourceId: 'secret-1',
      expectedRevision: 3,
      displayName: 'Rotated token',
      kind: 'token',
      toMode: 'plain',
    });
    const encryptedConversion = getActionSpec('secrets.shared.update').projectObservationInput?.({
      resourceId: 'secret-1',
      expectedRevision: 3,
      displayName: 'Rotated token',
      kind: 'token',
      storedContent,
      toMode: 'e2ee',
      keyEnvelopes: [keyEnvelope],
    });
    expect(encryptedConversion).toEqual({
      resourceId: 'secret-1',
      expectedRevision: 3,
      displayName: 'Rotated token',
      kind: 'token',
      toMode: 'e2ee',
    });

    for (const actionId of [
      'secrets.shared.create',
      'secrets.shared.promote',
      'secrets.shared.grants.set',
      'secrets.shared.update',
    ] as const) {
      const projected = getActionSpec(actionId).projectObservationInput?.({
        ...common,
        expectedSettingsVersion: 7,
        expectedRevision: 3,
        nextSettings: { t: 'encrypted', c: 'sealed-settings-envelope' },
      });
      expect(JSON.stringify(projected)).not.toContain(storedContent.c);
      expect(JSON.stringify(projected)).not.toContain('sealed-settings-envelope');
      expect(JSON.stringify(projected)).not.toContain(keyEnvelope.encryptedDataKey);
    }

    expect(getActionSpec('secrets.shared.create').projectObservationInput?.({
      ...common,
      unknownSecretField: 'must-not-pass-through',
    })).toEqual({});
  });
});
