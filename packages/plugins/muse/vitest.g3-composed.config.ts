import { mergeConfig } from 'vitest/config';

import composed from '../../../apps/cli/vitest.g3-composed.config';
import base from './vitest.config';

export default mergeConfig(base, {
  test: {
    testTimeout: composed.test?.testTimeout,
    hookTimeout: composed.test?.hookTimeout,
  },
});
