import { describe, expect, it, vi } from 'vitest';

import type {
  PluginContributionIdentityV1,
  QualifiedConnectedAccountPurposeBindingTargetV1,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import type { ResolvedFirstPartyManagedProviderFacet } from './types';
import {
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from './resolvePurposeBindingSnapshot';

const implementationIdentity = {
  pluginId: 'happier.provider.gateway',
  localId: 'gateway',
} as const;
const requiredService = {
  pluginId: 'happier.connected-account.openai',
  localId: 'codex',
} as const;
const optionalService = {
  pluginId: 'happier.connected-account.anthropic',
  localId: 'claude',
} as const;

function purpose(value: string): QualifiedConnectedAccountPurposeV1 {
  return {
    consumer: implementationIdentity,
    purpose: value,
  };
}

function accountTarget(
  service: PluginContributionIdentityV1,
  accountId: string,
): QualifiedConnectedAccountPurposeBindingTargetV1 {
  return {
    kind: 'account',
    account: { service, accountId },
  };
}

const facet = {
  managedEndpoint: {
    localService: {
      id: 'gateway-managed',
      launch: {
        kind: 'packaged-runtime-binary',
        directorySegments: ['tools', 'unpacked'],
        executableBaseName: 'gateway-managed',
        privateConfigPathFlag: '--config',
      },
      launchMode: {
        kind: 'assignAndInject',
        portPolicy: { kind: 'allocated' },
      },
      hostPolicy: { kind: 'loopback' },
      name: { strategy: 'fixed', name: 'Gateway' },
      healthCheck: { kind: 'http', path: '/healthz' },
      restart: { kind: 'never' },
      cleanup: { staleAfterMs: 60_000 },
    },
    protocols: ['openai-responses'],
  },
  connectedAccounts: [{
    purpose: 'required-upstream',
    service: requiredService,
    required: true,
  }, {
    purpose: 'optional-upstream',
    service: optionalService,
    required: false,
  }],
  requestAuthUses: [{
    purpose: 'required-upstream',
    materialization: {
      kind: 'httpHeaders',
      origin: 'https://required.example.test',
      headerNames: ['authorization'],
    },
  }, {
    purpose: 'optional-upstream',
    materialization: {
      kind: 'httpHeaders',
      origin: 'https://optional.example.test',
      headerNames: ['authorization'],
    },
  }],
} satisfies ResolvedFirstPartyManagedProviderFacet;

describe('resolveManagedProviderPurposeBindingSnapshot', () => {
  it('delegates every declared intent exactly once to C with only its declared service scope', async () => {
    const requiredIntent = {
      purpose: purpose('required-upstream'),
      target: accountTarget(requiredService, 'work'),
    };
    const optionalIntent = {
      purpose: purpose('optional-upstream'),
      target: accountTarget(optionalService, 'personal'),
    };
    const resolveBindingIntent = vi.fn<ResolveManagedProviderPurposeBindingIntent>(
      async (input) => ({
        purpose: input.purpose,
        target: input.target,
      }),
    );
    const signal = new AbortController().signal;

    await expect(resolveManagedProviderPurposeBindingSnapshot({
      implementationIdentity,
      facet,
      purposeBindingIntents: {
        v: 1,
        bindings: [requiredIntent, optionalIntent],
      },
      resolveBindingIntent,
      signal,
    })).resolves.toEqual({
      v: 1,
      bindings: [requiredIntent, optionalIntent],
    });
    expect(resolveBindingIntent).toHaveBeenCalledTimes(2);
    expect(resolveBindingIntent).toHaveBeenNthCalledWith(1, {
      ...requiredIntent,
      serviceRefs: [requiredService],
      signal,
    });
    expect(resolveBindingIntent).toHaveBeenNthCalledWith(2, {
      ...optionalIntent,
      serviceRefs: [optionalService],
      signal,
    });
  });

  it('fails closed when C resolves a different target', async () => {
    const intent = {
      purpose: purpose('required-upstream'),
      target: accountTarget(requiredService, 'work'),
    };

    await expect(resolveManagedProviderPurposeBindingSnapshot({
      implementationIdentity,
      facet,
      purposeBindingIntents: { v: 1, bindings: [intent] },
      resolveBindingIntent: async (input) => ({
        purpose: input.purpose,
        target: accountTarget(requiredService, 'other'),
      }),
    })).rejects.toThrow('managed_provider_purpose_binding_owner_mismatch');
  });

  it('rejects an undeclared service and a missing required purpose before producing a snapshot', async () => {
    const resolveBindingIntent = vi.fn<ResolveManagedProviderPurposeBindingIntent>(
      async (input) => ({ purpose: input.purpose, target: input.target }),
    );
    await expect(resolveManagedProviderPurposeBindingSnapshot({
      implementationIdentity,
      facet,
      purposeBindingIntents: {
        v: 1,
        bindings: [{
          purpose: purpose('required-upstream'),
          target: accountTarget(optionalService, 'wrong-service'),
        }],
      },
      resolveBindingIntent,
    })).rejects.toThrow('managed_provider_purpose_binding_service_invalid');
    expect(resolveBindingIntent).not.toHaveBeenCalled();

    await expect(resolveManagedProviderPurposeBindingSnapshot({
      implementationIdentity,
      facet,
      purposeBindingIntents: {
        v: 1,
        bindings: [{
          purpose: purpose('optional-upstream'),
          target: accountTarget(optionalService, 'personal'),
        }],
      },
      resolveBindingIntent,
    })).rejects.toThrow('managed_provider_required_purpose_binding_missing');
  });
});
