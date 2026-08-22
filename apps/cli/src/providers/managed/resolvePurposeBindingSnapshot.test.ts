import { describe, expect, it, vi } from 'vitest';

import type {
  PluginContributionIdentityV1,
  QualifiedConnectedAccountPurposeBindingTargetV1,
  QualifiedConnectedAccountPurposeV1,
  ResolvedProviderManagedRuntimeDeclarationV1,
} from '@happier-dev/protocol';

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

const connectedAccounts = [{
    purpose: 'required-upstream',
    service: requiredService,
    required: true,
  }, {
    purpose: 'optional-upstream',
    service: optionalService,
    required: false,
  }] satisfies ResolvedProviderManagedRuntimeDeclarationV1['connectedAccounts'];

describe('resolveManagedProviderPurposeBindingSnapshot', () => {
  it('accepts a zero-purpose public managed declaration without invoking the binding owner', async () => {
    const resolveBindingIntent = vi.fn<ResolveManagedProviderPurposeBindingIntent>();
    await expect(resolveManagedProviderPurposeBindingSnapshot({
      implementationIdentity,
      connectedAccounts: [],
      purposeBindingIntents: { v: 1, bindings: [] },
      resolveBindingIntent,
    })).resolves.toEqual({ v: 1, bindings: [] });
    expect(resolveBindingIntent).not.toHaveBeenCalled();
  });

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
      connectedAccounts,
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
      connectedAccounts,
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
      connectedAccounts,
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
      connectedAccounts,
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
