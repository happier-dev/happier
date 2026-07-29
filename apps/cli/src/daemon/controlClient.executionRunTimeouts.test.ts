import { describe, expect, it } from 'vitest';

import { resolveExecutionRunConnectedServiceMaterializeTimeoutMs } from './controlClient';

describe('resolveExecutionRunConnectedServiceMaterializeTimeoutMs', () => {
  it('uses a materialization-sized default and clamps explicit overrides', () => {
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({})).toBe(120_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '250000',
    })).toBe(250_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '10',
    })).toBe(1_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '9999999',
    })).toBe(600_000);
  });
});
