import { describe, expect, it } from 'vitest';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';

import { createMuseCatalog } from './catalog.js';
import { openMuseMsp } from './msp.js';
import { createMuseMspProcessFixture } from './testkit/mspProcess.js';

describe('Muse Session-scoped model catalog', () => {
  it('passes the accepted native Session UUID only for a Session catalog read', async () => {
    const { launch, ...boundary } = await createMuseMspProcessFixture();
    const exec = createStablePluginExecService({ signal: new AbortController().signal,
      isOccurrenceCurrent: () => true, ...boundary });
    const msp = await openMuseMsp({ exec, launch });
    try {
      const result = await msp.command('session/start', { workspaceRoot: '/selected/worktree' });
      const session = result && typeof result === 'object' && !Array.isArray(result) ? result.session : null;
      const sessionId = session && typeof session === 'object' && !Array.isArray(session) ? session.sessionId : null;
      if (typeof sessionId !== 'string') throw new Error('Native playback must return its accepted Session UUID');
      const catalog = createMuseCatalog(msp.client);
      await catalog.refresh();
      await catalog.refresh({ sessionId });
      expect(await msp.client.request('fixture/inspect')).toMatchObject({
        modelListSessionIds: [null, sessionId],
      });
    } finally { await msp.dispose(); }
  });
});
