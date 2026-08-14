import { describe, expect, it } from 'vitest';

import {
  QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
} from './qualifiedConnectedAccountsV4.js';

const service = {
  pluginId: 'acme.connected-accounts',
  localId: 'git/hosting',
} as const;
const ref = { service, accountId: 'team/legacy' } as const;
const credentialRevision = 'csr_abcdefghijklmnopqrstuvwxyz';

describe('qualified connected-account V4 revision semantics', () => {
  it('publishes legacy-unfenced rows as an explicit null revision at every V4 read boundary', () => {
    const revision = {
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    } as const;

    expect(QualifiedConnectedAccountProfileV4Schema.parse({
      ref,
      status: 'needs_reauth',
      authenticationModeId: null,
      configurationReady: false,
      configurationRevision: null,
      scopes: [],
      ...revision,
    })).toMatchObject(revision);
    expect(QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref,
      authenticationModeId: null,
      configurationRevision: null,
      content: { t: 'encrypted', c: 'opaque-legacy-credential' },
      metadata: { scopes: [] },
      ...revision,
    })).toMatchObject(revision);
    expect(QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
      target: { kind: 'account', ref },
      authenticationModeId: null,
      configurationRevision: 'config-revision-3',
      configurationContent: {
        t: 'encrypted',
        c: 'opaque-legacy-configuration',
      },
      ...revision,
    })).toMatchObject(revision);
  });

  it('requires the exact revision semantics/revision pair instead of an optional revision', () => {
    const profile = {
      ref,
      status: 'connected',
      authenticationModeId: 'oauth',
      configurationReady: true,
      configurationRevision: 'config-revision-3',
      scopes: [],
    } as const;

    expect(QualifiedConnectedAccountProfileV4Schema.safeParse({
      ...profile,
      revisionSemantics: 'revisioned',
      credentialRevision,
    }).success).toBe(true);
    expect(QualifiedConnectedAccountProfileV4Schema.safeParse({
      ...profile,
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    }).success).toBe(true);
    expect(QualifiedConnectedAccountProfileV4Schema.safeParse({
      ...profile,
      revisionSemantics: 'revisioned',
      credentialRevision: null,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountProfileV4Schema.safeParse({
      ...profile,
      revisionSemantics: 'legacy_unfenced',
      credentialRevision,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountProfileV4Schema.safeParse({
      ...profile,
      credentialRevision,
    }).success).toBe(false);
  });
});
