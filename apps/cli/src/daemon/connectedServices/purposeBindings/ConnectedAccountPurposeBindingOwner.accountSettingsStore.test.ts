import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSettingMutationV1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import {
  createActiveAccountSettingsConnectedAccountPurposeBindingStore,
  createConnectedAccountPurposeBindingOwner,
} from './ConnectedAccountPurposeBindingOwner';

const accountSettingsIo = vi.hoisted(() => ({
  current: null as Readonly<Record<string, unknown>> | null,
  update: vi.fn(),
}));

vi.mock('@/plugins/runtime/context/accountSettingsStorage', () => ({
  readActivePluginAccountSettings: () => accountSettingsIo.current,
  updateActivePluginAccountSettings: accountSettingsIo.update,
}));

const purpose = {
  consumer: { pluginId: 'happier.agent.test', localId: 'runtime' },
  purpose: 'model-request',
} as const;

const service = {
  pluginId: 'happier.connected-account.test',
  localId: 'subscription',
} as const;

function createOwner() {
  return createConnectedAccountPurposeBindingOwner({
    store: createActiveAccountSettingsConnectedAccountPurposeBindingStore(),
    selectTarget: async () => ({
      kind: 'account' as const,
      account: { service, accountId: 'selected' },
    }),
    resolveTarget: async (target) => target.kind === 'account'
      ? {
          displayName: `Account ${target.account.accountId}`,
          account: target.account,
        }
      : {
          displayName: `Group ${target.groupId}`,
          account: { service: target.service, accountId: 'selected' },
    },
    materializeAccount: async () => ({ kind: 'environment', env: {} }),
    async projectTargetAccounts() {
      throw new Error('target-scoped listing is outside Account Settings persistence tests');
    },
    async assertTargetAccountMaterializable() {
      throw new Error('listed-account materialization is outside Account Settings persistence tests');
    },
  });
}

function beginWith(settings: Readonly<Record<string, unknown>>) {
  accountSettingsIo.current = settings;
  accountSettingsIo.update.mockImplementation(async (mutationOrMutate) => {
    const current = accountSettingsIo.current ?? {};
    const next = typeof mutationOrMutate === 'function'
      ? mutationOrMutate(current)
      : (() => {
        const applied = applyAccountSettingMutationV1(current, mutationOrMutate);
        if (applied.status === 'invalid') {
          return applied;
        }
        return applied.raw;
      })();
    if ('status' in next && next.status === 'invalid') {
      return { status: 'invalid', reason: next.reason };
    }
    accountSettingsIo.current = next;
    return {
      status: 'applied' as const,
      version: 1,
      settings: next,
    };
  });
}

const authorized = {
  purpose,
  serviceRefs: [service],
  assertGenerationCurrent: () => undefined,
} as const;

describe('active Account Settings purpose-binding store', () => {
  beforeEach(() => {
    accountSettingsIo.current = null;
    accountSettingsIo.update.mockReset();
  });

  it.each([
    { label: 'an invalid object', root: { malformed: true } },
    { label: 'a null root', root: null },
  ])('fails closed before Account Settings CAS when selection sees $label', async ({ root }) => {
    const rawSettings = {
      untouchedRoot: { bytes: ['must', 'survive'] },
      connectedAccountPurposeBindingsV1: root,
    };
    beginWith(rawSettings);

    await expect(createOwner().requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'saved_secret_reference_invalid' });

    expect(accountSettingsIo.update).not.toHaveBeenCalled();
    expect(accountSettingsIo.current).toBe(rawSettings);
  });

  it.each([
    { label: 'an invalid object', root: { malformed: true } },
    { label: 'a null root', root: null },
  ])('fails closed before Account Settings CAS when reconciliation sees $label', async ({ root }) => {
    const rawSettings = {
      untouchedRoot: { bytes: ['must', 'survive'] },
      connectedAccountPurposeBindingsV1: root,
    };
    beginWith(rawSettings);
    const publish = vi.fn();

    await expect(createOwner().reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }],
      publish,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'saved_secret_reference_invalid' });

    expect(accountSettingsIo.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(accountSettingsIo.current).toBe(rawSettings);
  });

  it('fails closed when the retrying CAS baseline gains a malformed present bindings root', async () => {
    const activeSettings = {
      untouchedRoot: { bytes: ['active', 'snapshot'] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    } as const;
    const retryBaseline = {
      untouchedRoot: { bytes: ['must', 'survive'] },
      connectedAccountPurposeBindingsV1: { malformed: true },
    } as const;
    const retryRoot = retryBaseline.connectedAccountPurposeBindingsV1;
    const submitRetryWrite = vi.fn();
    accountSettingsIo.current = activeSettings;
    accountSettingsIo.update.mockImplementation(async (mutationOrMutate) => {
      // The live bridge forwards a retry callback. Invoking it against this
      // freshly-read winner is what must reject the malformed present root
      // before any replacement can be submitted.
      if (typeof mutationOrMutate === 'function') {
        const next = mutationOrMutate(retryBaseline);
        submitRetryWrite(next);
        return {
          status: 'applied' as const,
          version: 1,
          settings: next,
        };
      }
      const applied = applyAccountSettingMutationV1(retryBaseline, mutationOrMutate);
      if (applied.status === 'invalid') {
        return { status: 'invalid', reason: applied.reason };
      }
      submitRetryWrite(applied.raw);
      return {
        status: 'applied' as const,
        version: 1,
        settings: applied.raw,
      };
    });

    await expect(createOwner().requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'saved_secret_reference_invalid' });

    expect(accountSettingsIo.update).toHaveBeenCalledOnce();
    expect(submitRetryWrite).not.toHaveBeenCalled();
    expect(retryBaseline.connectedAccountPurposeBindingsV1).toBe(retryRoot);
    expect(retryBaseline).toEqual({
      untouchedRoot: { bytes: ['must', 'survive'] },
      connectedAccountPurposeBindingsV1: { malformed: true },
    });
    expect(accountSettingsIo.current).toBe(activeSettings);
  });

  it('initializes an absent bindings root through selection while preserving unrelated Account Settings roots', async () => {
    const rawSettings = {
      untouchedRoot: { bytes: ['must', 'survive'] },
    } as const;
    beginWith(rawSettings);

    await expect(createOwner().requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      account: { service, accountId: 'selected' },
    });

    expect(accountSettingsIo.update).toHaveBeenCalledOnce();
    expect(accountSettingsIo.current).toEqual({
      untouchedRoot: { bytes: ['must', 'survive'] },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose,
          target: {
            kind: 'account',
            account: { service, accountId: 'selected' },
          },
        }],
      },
    });
  });

  it('passes the selection cancellation signal into the Account Settings update owner', async () => {
    beginWith({});
    const controller = new AbortController();

    await expect(createOwner().requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal: controller.signal,
    })).resolves.toMatchObject({
      account: { service, accountId: 'selected' },
    });

    expect(accountSettingsIo.update).toHaveBeenCalledWith(
      expect.any(Function),
      { signal: controller.signal },
    );
  });

  it('initializes an absent bindings root through reconciliation while preserving unrelated Account Settings roots', async () => {
    const rawSettings = {
      untouchedRoot: { bytes: ['must', 'survive'] },
    } as const;
    beginWith(rawSettings);
    const publish = vi.fn();

    await expect(createOwner().reconcileAuthorizedPurposes({
      consumerScopes: [{
        consumer: purpose.consumer,
        authorizedPurposes: [],
      }],
      publish,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    expect(accountSettingsIo.update).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(accountSettingsIo.current).toEqual({
      untouchedRoot: { bytes: ['must', 'survive'] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    });
  });

  it('reapplies one qualified purpose selection to a CAS winner that added another purpose', async () => {
    const winnerPurpose = {
      consumer: { pluginId: 'happier.agent.winner', localId: 'runtime' },
      purpose: 'model-request',
    } as const;
    const winnerSettings = {
      untouchedRoot: { bytes: ['winner'] },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: winnerPurpose,
          target: {
            kind: 'account',
            account: { service, accountId: 'winner-account' },
          },
        }],
      },
    } as const;
    const initialSettings = {
      untouchedRoot: { bytes: ['initial'] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    } as const;
    accountSettingsIo.current = initialSettings;
    accountSettingsIo.update.mockImplementation(async (mutationOrMutate) => {
      const applyTo = (settings: Readonly<Record<string, unknown>>) => {
        if (typeof mutationOrMutate === 'function') {
          return mutationOrMutate(settings);
        }
        const applied = applyAccountSettingMutationV1(settings, mutationOrMutate);
        if (applied.status === 'invalid') {
          throw new Error(`Unexpected invalid Account Settings mutation: ${applied.reason}`);
        }
        return applied.raw;
      };
      // The first candidate loses its CAS. The actual retry must use the
      // winner as its base instead of replaying the initial bindings root.
      applyTo(initialSettings);
      const finalSettings = applyTo(winnerSettings);
      accountSettingsIo.current = finalSettings;
      return {
        status: 'applied' as const,
        version: 2,
        settings: finalSettings,
      };
    });

    await expect(createOwner().requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ account: { service, accountId: 'selected' } });

    expect(accountSettingsIo.current).toMatchObject({
      untouchedRoot: { bytes: ['winner'] },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: expect.arrayContaining([
          expect.objectContaining({
            purpose: winnerPurpose,
            target: {
              kind: 'account',
              account: { service, accountId: 'winner-account' },
            },
          }),
          expect.objectContaining({
            purpose,
            target: {
              kind: 'account',
              account: { service, accountId: 'selected' },
            },
          }),
        ]),
      },
    });
  });

  it('keeps a terminal Account Settings conflict structured instead of parsing it as bindings', async () => {
    accountSettingsIo.current = {
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    accountSettingsIo.update.mockResolvedValue({
      status: 'conflict',
      currentVersion: 7,
    });

    await expect(createOwner().requestSelection({
      ...authorized,
      reason: 'Choose account',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_settings_conflict',
      retryable: true,
      details: { currentVersion: '7' },
    });
  });

  describe('an unavailable Account Settings boundary', () => {
    const unavailable = Object.freeze({
      status: 'unavailable' as const,
      retryable: true,
      reason: 'account_settings_storage_unavailable',
    });

    beforeEach(() => {
      accountSettingsIo.current = {
        connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
      };
      accountSettingsIo.update.mockResolvedValue(unavailable);
    });

    it('defers the durable prune and still publishes the candidate registry', async () => {
      const publish = vi.fn();

      await expect(createOwner().reconcileAuthorizedPurposes({
        consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
        publish,
        signal: new AbortController().signal,
      })).resolves.toBeUndefined();

      expect(publish).toHaveBeenCalledOnce();
    });

    it('reports the boundary refusal reason and its retryability to the operator', async () => {
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

      await createOwner().reconcileAuthorizedPurposes({
        consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
        publish: () => undefined,
        signal: new AbortController().signal,
      });

      const reported = debug.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(reported).toContain('account_settings_storage_unavailable');
      expect(reported).toContain('"retryable":true');
      debug.mockRestore();
    });

    it('still fails a user-initiated selection instead of reporting a bind that did not happen', async () => {
      await expect(createOwner().requestSelection({
        ...authorized,
        reason: 'Choose account',
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'plugin_connected_account_settings_unavailable',
        retryable: true,
        details: { reason: 'account_settings_storage_unavailable' },
      });
    });
  });
});
