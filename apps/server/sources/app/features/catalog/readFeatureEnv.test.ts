import { describe, expect, it } from 'vitest';

import { readConnectedServicesFeatureEnv } from './readFeatureEnv';

describe('readConnectedServicesFeatureEnv', () => {
  it('defaults quotasEnabled to false when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readConnectedServicesFeatureEnv(env);
    expect(res.quotasEnabled).toBe(false);
  });
});

