import { describe, expect, it } from 'vitest';

import { settleDaemonOptionalCapability, type DaemonOptionalCapabilityResult } from './optionalCapabilities';

describe('optional daemon startup capabilities', () => {
  it.each(['account_catalogs', 'plugin_runtime', 'connected_service_reconcile'] as const)(
    'settles a failed %s without rejecting daemon startup and reports its typed reason', async capability => {
      const failure = Object.assign(new Error('capability transport unavailable'), { code: 'ECONNREFUSED' });
      const reports: DaemonOptionalCapabilityResult[] = [];
      await expect(settleDaemonOptionalCapability(capability, Promise.reject(failure), result => reports.push(result)))
        .resolves.toEqual({ status: 'unavailable', capability, error: failure });
      expect(reports).toEqual([{ status: 'unavailable', capability, error: failure }]);
    },
  );

  it('preserves eventual capability success without publishing an unavailable diagnostic', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const reports: DaemonOptionalCapabilityResult[] = [];
    const operation = settleDaemonOptionalCapability('connected_service_reconcile', pending, result => reports.push(result));
    release();
    await expect(operation).resolves.toEqual({ status: 'ready', capability: 'connected_service_reconcile' });
    expect(reports).toEqual([]);
  });
});
