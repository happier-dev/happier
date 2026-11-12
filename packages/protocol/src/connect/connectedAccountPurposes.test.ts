import { describe, expect, it } from 'vitest';
import { canonicalBoundedRecordKeySchema } from '../common/canonicalRecordKey.js';

import {
  type ConnectedAccountMaterializationRequest,
  ConnectedAccountMaterializationRequestSchema,
  type PluginConnectedAccountMaterializationKind,
  ConnectedAccountPurposeDeclarationV1Schema,
  ConnectedAccountPurposeDeclarationsV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
} from './connectedAccountPurposes.js';

describe('connected-account consumer purposes', () => {
  it('retains an exact managed Provider endpoint route and rejects unknown route authority', () => {
    const declaration = {
      purpose: 'meta-inference',
      service: { pluginId: 'happier.agent.muse', localId: 'muse' },
      managedProviderEndpoint: {
        provider: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        purpose: 'meta-upstream',
        modelIdPrefix: 'meta/',
      },
    };
    expect(ConnectedAccountPurposeDeclarationV1Schema.parse(declaration)).toEqual(declaration);
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      ...declaration,
      managedProviderEndpoint: { ...declaration.managedProviderEndpoint, endpointUrl: 'https://other.example' },
    }).success).toBe(false);
    for (const route of [
      { ...declaration.managedProviderEndpoint, modelIdPrefix: '' },
      { provider: 'cliproxyapi', purpose: 'meta-upstream' },
      { provider: declaration.managedProviderEndpoint.provider, purpose: '' },
      { provider: { ...declaration.managedProviderEndpoint.provider, endpoint: 'other' }, purpose: 'meta-upstream' },
    ]) {
      expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
        ...declaration, managedProviderEndpoint: route,
      }).success).toBe(false);
    }
  });
  it('owns the strict bounded materialization request contract for every branch', () => {
    expect(ConnectedAccountMaterializationRequestSchema.parse({
      kind: 'httpHeaders',
      origin: 'https://api.example.com',
      headerNames: ['Authorization', 'X-Account-Id'],
    })).toEqual({
      kind: 'httpHeaders',
      origin: 'https://api.example.com',
      headerNames: ['authorization', 'x-account-id'],
    });
    expect(ConnectedAccountMaterializationRequestSchema.parse({
      kind: 'environment',
      keys: ['ACCESS_TOKEN'],
    })).toEqual({
      kind: 'environment',
      keys: ['ACCESS_TOKEN'],
    });
    expect(ConnectedAccountMaterializationRequestSchema.parse({
      kind: 'files',
      fileIds: ['service-account'],
    })).toEqual({
      kind: 'files',
      fileIds: ['service-account'],
    });

    for (const request of [
      { kind: 'httpHeaders', origin: 'https://api.example.com', headerNames: ['authorization'], extra: true },
      { kind: 'environment', keys: ['ACCESS_TOKEN'], extra: true },
      { kind: 'files', fileIds: ['service-account'], extra: true },
    ]) {
      expect(ConnectedAccountMaterializationRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it('preserves explicit key bounds while allowing unbounded canonical credential destinations', () => {
    expect(canonicalBoundedRecordKeySchema(3).safeParse('abc').success).toBe(true);
    expect(canonicalBoundedRecordKeySchema(3).safeParse('abcd').success).toBe(false);
    expect(canonicalBoundedRecordKeySchema().safeParse('X'.repeat(512)).success).toBe(true);
  });

  it('accepts canonical HTTPS origins and unique destinations without local name count or length ceilings', () => {
    for (const origin of [
      'http://api.example.com',
      'https://user:secret@api.example.com',
      'https://api.example.com/path',
      'https://api.example.com?query=1',
      'https://api.example.com#fragment',
      'https://api.example.com/',
      `https://${'a'.repeat(2_048)}.example.com`,
    ]) {
      expect(ConnectedAccountMaterializationRequestSchema.safeParse({
        kind: 'httpHeaders',
        origin: origin,
        headerNames: ['authorization'],
      }).success).toBe(false);
    }

    expect(ConnectedAccountMaterializationRequestSchema.safeParse({
      kind: 'httpHeaders',
      origin: 'https://api.example.com',
      headerNames: ['Authorization', 'authorization'],
    }).success).toBe(false);
    expect(ConnectedAccountMaterializationRequestSchema.safeParse({
      kind: 'environment',
      keys: ['ACCESS_TOKEN', 'ACCESS_TOKEN'],
    }).success).toBe(false);
    expect(ConnectedAccountMaterializationRequestSchema.safeParse({
      kind: 'files',
      fileIds: ['service-account', 'service-account'],
    }).success).toBe(false);

    const destinations = Array.from({ length: 33 }, (_, index) => `DESTINATION_${index}_${'X'.repeat(256)}`);
    for (const request of [
      { kind: 'httpHeaders', origin: 'https://api.example.com', headerNames: destinations },
      { kind: 'environment', keys: destinations },
      { kind: 'files', fileIds: destinations },
    ] satisfies readonly ConnectedAccountMaterializationRequest[]) {
      expect(ConnectedAccountMaterializationRequestSchema.safeParse(request).success).toBe(true);
    }
    for (const name of ['', ' padded', 'padded ', 'bad\u0000name', 'bad\nname', '__proto__', 'prototype', 'constructor']) {
      expect(ConnectedAccountMaterializationRequestSchema.safeParse({ kind: 'environment', keys: [name] }).success).toBe(false);
    }
  });

  it('keeps declarations strict and permits local or qualified service references', () => {
    expect(ConnectedAccountPurposeDeclarationV1Schema.parse({
      purpose: 'primary',
      service: 'openai-codex',
    })).toEqual({
      purpose: 'primary',
      service: 'openai-codex',
    });
    expect(ConnectedAccountPurposeDeclarationV1Schema.parse({
      purpose: 'realtime_upstream',
      service: {
        pluginId: 'happier.connected-account.openai',
        localId: 'openai-codex',
      },
      title: {
        key: 'plugins.example.connectedAccounts.realtimeUpstream',
        fallback: 'Realtime upstream account',
      },
      required: false,
      materializationKinds: ['files', 'environment'],
      credentialKinds: ['oauth', 'token'],
    })).toEqual({
      purpose: 'realtime_upstream',
      service: {
        pluginId: 'happier.connected-account.openai',
        localId: 'openai-codex',
      },
      title: {
        key: 'plugins.example.connectedAccounts.realtimeUpstream',
        fallback: 'Realtime upstream account',
      },
      required: false,
      materializationKinds: ['files', 'environment'],
      credentialKinds: ['oauth', 'token'],
    });
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary',
      service: 'openai-codex',
      accountId: 'must-not-be-authority',
    }).success).toBe(false);
  });

  it('accepts only an explicit unique non-empty credential kind set', () => {
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary', service: 'novel-service', credentialKinds: ['oauth', 'token'],
    }).success).toBe(true);
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary', service: 'novel-service', credentialKinds: [],
    }).success).toBe(false);
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary', service: 'novel-service', credentialKinds: ['token', 'token'],
    }).success).toBe(false);
  });

  it('accepts only an explicit unique non-empty raw materialization kind set', () => {
    const materializationKinds = [
      'httpHeaders',
      'environment',
      'files',
    ] as const satisfies readonly PluginConnectedAccountMaterializationKind[];

    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary',
      service: 'openai-codex',
      materializationKinds,
    }).success).toBe(true);
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary',
      service: 'openai-codex',
      materializationKinds: [],
    }).success).toBe(false);
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary',
      service: 'openai-codex',
      materializationKinds: ['files', 'files'],
    }).success).toBe(false);
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary',
      service: 'openai-codex',
      materializationKinds: ['rawSecret'],
    }).success).toBe(false);
  });

  it('rejects duplicate purpose ids independently of their service reference', () => {
    expect(ConnectedAccountPurposeDeclarationsV1Schema.safeParse([
      { purpose: 'primary', service: 'openai-codex' },
      { purpose: 'primary', service: 'claude-subscription' },
    ]).success).toBe(false);
  });

  it('accepts 32 purpose declarations and rejects the first overflow entry', () => {
    const declarations = Array.from({ length: 33 }, (_, index) => ({
      purpose: `purpose-${index}`,
      service: `service-${index}`,
    }));

    expect(ConnectedAccountPurposeDeclarationsV1Schema.safeParse(
      declarations.slice(0, 32),
    ).success).toBe(true);
    expect(ConnectedAccountPurposeDeclarationsV1Schema.safeParse(
      declarations,
    ).success).toBe(false);
  });

  it('qualifies a local purpose with its consumer contribution identity', () => {
    expect(QualifiedConnectedAccountPurposeV1Schema.parse({
      consumer: {
        pluginId: 'example.consumer',
        localId: 'run-action',
      },
      purpose: 'upstream-account',
    })).toEqual({
      consumer: {
        pluginId: 'example.consumer',
        localId: 'run-action',
      },
      purpose: 'upstream-account',
    });
    expect(QualifiedConnectedAccountPurposeV1Schema.safeParse({
      consumer: {
        pluginId: 'example.consumer',
        localId: 'run-action',
      },
      purpose: 'upstream-account',
      service: 'must-not-be-a-second-selector',
    }).success).toBe(false);
  });
});
