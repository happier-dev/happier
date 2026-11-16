import { describe, expect, it } from 'vitest';
import { runInHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';

import {
  DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS,
  resolveConnectedServicesServerApiTimeoutMs,
} from './connectedServicesServerApiTimeout';

describe('resolveConnectedServicesServerApiTimeoutMs', () => {
  it('reads each hosted Session source while explicit environments retain precedence', async () => {
    const read = (timeout: string) => runInHostedSessionScope({ environment: {
      NODE_ENV: 'test',
      HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS: timeout,
    } }, async () => {
      await Promise.resolve();
      return [resolveConnectedServicesServerApiTimeoutMs(), resolveConnectedServicesServerApiTimeoutMs({
        HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS: '4321',
      })];
    });
    expect(await Promise.all([read('1234'), read('5678')])).toEqual([[1234, 4321], [5678, 4321]]);
  });
  it('uses the default connected-services server API timeout when no override is set', () => {
    expect(resolveConnectedServicesServerApiTimeoutMs({})).toBe(DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS);
  });

  it('uses a positive integer override', () => {
    expect(resolveConnectedServicesServerApiTimeoutMs({
      HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS: '45000',
    })).toBe(45_000);
  });

  it('falls back to the default for invalid or non-positive overrides', () => {
    expect(resolveConnectedServicesServerApiTimeoutMs({
      HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS: 'not-a-number',
    })).toBe(DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS);
    expect(resolveConnectedServicesServerApiTimeoutMs({
      HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS: '0',
    })).toBe(DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS);
  });

  it('clamps unusually small or large overrides', () => {
    expect(resolveConnectedServicesServerApiTimeoutMs({
      HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS: '250',
    })).toBe(1_000);
    expect(resolveConnectedServicesServerApiTimeoutMs({
      HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS: '999999',
    })).toBe(120_000);
  });
});
