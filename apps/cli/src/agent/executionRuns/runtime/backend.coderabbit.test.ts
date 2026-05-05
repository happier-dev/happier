import { describe, expect, it } from 'vitest';

import { createExecutionRunBackend } from './backend.testkit';

describe('execution run backend (coderabbit)', () => {
  it('fails closed through the central runtime unless CodeRabbit is registered through runtimeCore', async () => {
    const backend = createExecutionRunBackend({
      cwd: process.cwd(),
      backendId: 'coderabbit',
      permissionMode: 'read_only',
    });

    await expect(backend.startSession()).rejects.toThrow('Unsupported execution-run backend: coderabbit');
  });
});
