import { describe, expect, it } from 'vitest';

import {
  type ConnectedAccountMaterializationRequest,
  ConnectedAccountMaterializationRequestSchema,
  type PluginConnectedAccountMaterializationKind,
  ConnectedAccountPurposeDeclarationV1Schema,
  ConnectedAccountPurposeDeclarationsV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
} from './connectedAccountPurposes.js';

describe('connected-account consumer purposes', () => {
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

  it('accepts only canonical HTTPS origins and unique bounded destinations', () => {
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
        origin,
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

    const destinations = Array.from({ length: 33 }, (_, index) => `DESTINATION_${index}`);
    for (const request of [
      { kind: 'httpHeaders', origin: 'https://api.example.com', headerNames: destinations },
      { kind: 'environment', keys: destinations },
      { kind: 'files', fileIds: destinations },
    ] satisfies readonly ConnectedAccountMaterializationRequest[]) {
      const destinationsAtLimit = request.kind === 'httpHeaders'
        ? { ...request, headerNames: request.headerNames.slice(0, 32) }
        : request.kind === 'environment'
          ? { ...request, keys: request.keys.slice(0, 32) }
          : { ...request, fileIds: request.fileIds.slice(0, 32) };
      expect(ConnectedAccountMaterializationRequestSchema.safeParse(destinationsAtLimit).success).toBe(true);
      expect(ConnectedAccountMaterializationRequestSchema.safeParse(request).success).toBe(false);
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
    });
    expect(ConnectedAccountPurposeDeclarationV1Schema.safeParse({
      purpose: 'primary',
      service: 'openai-codex',
      accountId: 'must-not-be-authority',
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
