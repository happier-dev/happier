import { describe, expect, it } from 'vitest';

import { CURSOR_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';
import { CURSOR_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';
import { CURSOR_AGENT_RUNTIME_CONTRIBUTION as CATALOG_CURSOR_AGENT_RUNTIME_CONTRIBUTION } from './catalog.js';

describe('Cursor agent runtime contribution', () => {
  it('keeps legacy catalog data free of a competing preflight owner', () => {
    expect(CURSOR_AGENT_RUNTIME_CONTRIBUTION).toBe(CATALOG_CURSOR_AGENT_RUNTIME_CONTRIBUTION);
    expect(CATALOG_CURSOR_AGENT_RUNTIME_CONTRIBUTION).toEqual({ agentId: 'cursor' });
  });

  it('declares Cursor native models parsing without process authority', async () => {
    const models = CURSOR_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({
      toolId: 'cursor-agent',
      args: ['models'],
      ci: 'omit',
    });
    await expect(models?.parseOutput?.({
      ok: true,
      stdout: [
        'Available models',
        '',
        'auto - Auto',
        'composer-2.5-fast - Composer 2.5 Fast (current, default)',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    })).resolves.toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
    ]);
  });
});
