import { describe, expect, it, vi } from 'vitest';

import { reconcileConnectedServicesProjectionForPluginConsumers } from './reconcileConnectedServicesProjectionForPluginConsumers';

describe('reconcileConnectedServicesProjectionForPluginConsumers', () => {
  it('invalidates public Connected Accounts after successful sibling reconciliation', async () => {
    const reconcile = vi.fn(async () => undefined);
    const invalidateConnectedAccounts = vi.fn();

    await expect(reconcileConnectedServicesProjectionForPluginConsumers({
      notification: { kind: 'changed' },
      reconcile,
      invalidateConnectedAccounts,
    })).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledWith({ kind: 'changed' });
    expect(invalidateConnectedAccounts).toHaveBeenCalledOnce();
  });

  it('still invalidates public Connected Accounts when sibling reconciliation rejects', async () => {
    const failure = new Error('sibling reconciliation failed');
    const reconcile = vi.fn(async () => {
      throw failure;
    });
    const invalidateConnectedAccounts = vi.fn();

    await expect(reconcileConnectedServicesProjectionForPluginConsumers({
      notification: { kind: 'changed' },
      reconcile,
      invalidateConnectedAccounts,
    })).rejects.toBe(failure);
    expect(invalidateConnectedAccounts).toHaveBeenCalledOnce();
  });
});
