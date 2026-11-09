import { describe, expect, it } from 'vitest';

import { createCliActionExecutor } from './createCliActionExecutor';

describe('terminal Action authority', () => {
  it('treats a stored terminal login on the CLI surface as the person without any Account policy', async () => {
    const executor = createCliActionExecutor({
      token: 'terminal-authority-test',
      credentials: { token: 'terminal-authority-test', credentialProvenance: 'stored_session', encryption: null },
      sessionId: 'session-1',
      mode: 'plain',
      ctx: null,
      pluginActionExecutionOwner: 'current_process',
    });
    for (const context of [{ surface: 'cli' as const }, { surface: 'cli' as const, authority: 'present_user' as const },
      { surface: 'rpc' as const, authority: 'present_user' as const }]) {
      expect((await executor.prepare('approval.request.decide', {
        artifactId: 'artifact-1', decision: 'approve',
      }, context)).kind).toBe('ready');
    }
  });
});
