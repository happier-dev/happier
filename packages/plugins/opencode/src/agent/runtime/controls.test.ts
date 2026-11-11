import { describe, expect, it } from 'vitest';
import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { createOpenCodeNativeSessionControls } from './controls.js';

describe('OpenCode Session catalog requests', () => {
  it('rejects model requests without reading the native skills catalog', async () => {
    const controls = createOpenCodeNativeSessionControls();
    let nativeReads = 0;
    // This reader is the native server boundary; catalog routing stays real.
    controls.bindActiveSkillsReader('session', async () => {
      nativeReads += 1;
      return [{ name: 'review', description: 'Review the workspace' }];
    });
    const context = {
      session: { id: 'session', cwd: '/repo', activity: 'active', connectedAccounts: [] },
    } as AgentSessionControlContext;

    await expect(controls.sessions.catalog.list({ kind: 'models' }, context))
      .resolves.toMatchObject({ status: 'unsupported' });
    expect(nativeReads).toBe(0);

    await expect(controls.sessions.catalog.list({ kind: 'skills' }, context))
      .resolves.toMatchObject({ status: 'ok', kind: 'skills', items: [{ name: 'review' }] });
    expect(nativeReads).toBe(1);
  });
});
