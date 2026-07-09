import { describe, expect, it } from 'vitest';

import coreConfig from '../../../vitest.core.config';
import coreFastConfig from '../../../vitest.core.fast.config';
import providersConfig from '../../../vitest.providers.config';

describe('packages/tests Vitest worker caps', () => {
  it('caps parallel package test workers at six', () => {
    expect(coreConfig.test?.maxWorkers).toBe(6);
    expect(coreFastConfig.test?.maxWorkers).toBe(6);
    expect(providersConfig.test?.maxWorkers).toBe(6);
  });
});
