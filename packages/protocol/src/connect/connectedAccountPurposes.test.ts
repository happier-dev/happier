import { describe, expect, it } from 'vitest';

import {
  type PluginConnectedAccountMaterializationKind,
  ConnectedAccountPurposeDeclarationV1Schema,
  ConnectedAccountPurposeDeclarationsV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
} from './connectedAccountPurposes.js';

describe('connected-account consumer purposes', () => {
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
      required: false,
      materializationKinds: ['files', 'environment'],
    })).toEqual({
      purpose: 'realtime_upstream',
      service: {
        pluginId: 'happier.connected-account.openai',
        localId: 'openai-codex',
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
