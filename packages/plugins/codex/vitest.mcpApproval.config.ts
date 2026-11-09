import { defineConfig } from 'vitest/config';

import inMemoryConfig from '../../../apps/cli/vitest.inMemory.config';

// This contract crosses the native Agent adapter and real host permission owner.
export default defineConfig({
  ...inMemoryConfig,
  test: {
    ...inMemoryConfig.test,
    include: [
      'src/agent/runtime/appServer/interactions.mcpApprovalSubject.test.ts',
    ],
  },
});
