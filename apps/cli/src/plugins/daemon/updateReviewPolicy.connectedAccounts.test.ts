import { describe, expect, it } from 'vitest';
import type { ConnectedAccountPurposeDeclarationV1 } from '@happier-dev/protocol';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  hasReviewSensitivePluginUpdate,
  preserveValidPluginOptionalSelections,
} from './updateReviewPolicy';

function manifest(
  materializationKinds?: readonly ('environment' | 'files')[],
  service: ConnectedAccountPurposeDeclarationV1['service'] = 'account',
) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.consumer',
    hostAccess: {
      required: [],
      optional: [{
        id: 'upstream',
        capability: 'connectedAccounts',
        reason: 'Use the selected upstream account',
        scope: {
          serviceRefs: [service],
          operations: ['use'],
          ...(materializationKinds !== undefined
            ? { materializationKinds: [...materializationKinds] }
            : {}),
        },
      }],
    },
  }));
  if (!parsed) throw new Error('Expected canonical Connected Accounts manifest');
  return parsed;
}

function agentManifest(
  materializationKinds?: readonly ('environment' | 'files')[],
  service: ConnectedAccountPurposeDeclarationV1['service'] = 'account',
) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.agent.consumer',
    contributes: {
      agents: [{
        id: 'consumer',
        title: 'Consumer',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        connectedAccounts: [{
          purpose: 'upstream',
          service,
          ...(materializationKinds !== undefined
            ? { materializationKinds: [...materializationKinds] }
            : {}),
        }],
        capabilities: {
          sessions: {
            open: ['create'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      }],
    },
  }));
  if (!parsed) throw new Error('Expected canonical Connected Accounts Agent manifest');
  return parsed;
}

function networkManifest(service: ConnectedAccountPurposeDeclarationV1['service']) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.consumer',
    hostAccess: {
      required: [{
        id: 'upstream-origin',
        capability: 'network',
        reason: 'Call the selected upstream account',
        scope: {
          targets: [{ kind: 'connectedAccountOrigin', service }],
          methods: ['GET'],
        },
      }],
      optional: [],
    },
  }));
  if (!parsed) throw new Error('Expected canonical Connected Accounts network manifest');
  return parsed;
}

describe('Connected Accounts plugin update review policy', () => {
  it('treats kind order as canonical but makes every authority change review-sensitive', () => {
    const current = manifest(['environment', 'files']);

    expect(hasReviewSensitivePluginUpdate(
      current,
      manifest(['files', 'environment']),
    )).toBe(false);
    expect(hasReviewSensitivePluginUpdate(
      current,
      manifest(['environment']),
    )).toBe(true);
    expect(hasReviewSensitivePluginUpdate(
      current,
      manifest(),
    )).toBe(true);
  });

  it('preserves an optional selection only for the exact current materialization authority', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    const selection = registry.createSelection({
      pluginId: 'acme.consumer',
      accessId: 'upstream',
      capability: 'connectedAccounts',
      scope: {
        serviceRefs: ['account'],
        operations: ['use'],
        materializationKinds: ['environment'],
      },
      selectedAtMs: 1,
    });

    expect(preserveValidPluginOptionalSelections(
      'acme.consumer',
      manifest(['environment']),
      [selection],
    )).toEqual([selection]);
    expect(preserveValidPluginOptionalSelections(
      'acme.consumer',
      manifest(['environment', 'files']),
      [selection],
    )).toBeNull();
    expect(preserveValidPluginOptionalSelections(
      'acme.consumer',
      manifest(),
      [selection],
    )).toBeNull();
    expect(preserveValidPluginOptionalSelections(
      'acme.consumer',
      manifest(['environment'], {
        pluginId: 'acme.consumer',
        localId: 'account',
      }),
      [selection],
    )).toEqual([selection]);
    expect(preserveValidPluginOptionalSelections(
      'acme.consumer',
      manifest(['environment'], {
        pluginId: 'acme.accounts',
        localId: 'account',
      }),
      [selection],
    )).toBeNull();
  });

  it('makes generated Agent purpose materialization-authority changes review-sensitive', () => {
    const current = agentManifest(['environment', 'files']);

    expect(hasReviewSensitivePluginUpdate(
      current,
      agentManifest(['files', 'environment']),
    )).toBe(false);
    expect(hasReviewSensitivePluginUpdate(
      current,
      agentManifest(['environment']),
    )).toBe(true);
    expect(hasReviewSensitivePluginUpdate(
      current,
      agentManifest(),
    )).toBe(true);
    expect(hasReviewSensitivePluginUpdate(
      agentManifest(['environment']),
      current,
    )).toBe(true);
  });

  it('canonicalizes local and explicit self-qualified Agent purpose service references', () => {
    const local = agentManifest(undefined, 'account');
    const selfQualified = agentManifest(undefined, {
      pluginId: 'acme.agent.consumer',
      localId: 'account',
    });
    const external = agentManifest(undefined, {
      pluginId: 'acme.accounts',
      localId: 'account',
    });

    expect(hasReviewSensitivePluginUpdate(local, selfQualified)).toBe(false);
    expect(hasReviewSensitivePluginUpdate(selfQualified, local)).toBe(false);
    expect(hasReviewSensitivePluginUpdate(local, external)).toBe(true);
    expect(hasReviewSensitivePluginUpdate(external, local)).toBe(true);
  });

  it('canonicalizes local and explicit self-qualified manual Connected Accounts service references', () => {
    const local = manifest(undefined, 'account');
    const selfQualified = manifest(undefined, {
      pluginId: 'acme.consumer',
      localId: 'account',
    });
    const external = manifest(undefined, {
      pluginId: 'acme.accounts',
      localId: 'account',
    });

    expect(hasReviewSensitivePluginUpdate(local, selfQualified)).toBe(false);
    expect(hasReviewSensitivePluginUpdate(selfQualified, local)).toBe(false);
    expect(hasReviewSensitivePluginUpdate(local, external)).toBe(true);
    expect(hasReviewSensitivePluginUpdate(external, local)).toBe(true);
  });

  it('canonicalizes local and explicit self-qualified Connected Account network origins', () => {
    const local = networkManifest('account');
    const selfQualified = networkManifest({
      pluginId: 'acme.consumer',
      localId: 'account',
    });
    const external = networkManifest({
      pluginId: 'acme.accounts',
      localId: 'account',
    });

    expect(hasReviewSensitivePluginUpdate(local, selfQualified)).toBe(false);
    expect(hasReviewSensitivePluginUpdate(selfQualified, local)).toBe(false);
    expect(hasReviewSensitivePluginUpdate(local, external)).toBe(true);
    expect(hasReviewSensitivePluginUpdate(external, local)).toBe(true);
  });
});
