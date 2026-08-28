import { describe, expect, it } from 'vitest';

import { CURSOR_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

describe('Cursor Agent preflight declaration', () => {
  it('declares Cursor native models parsing without process authority', async () => {
    const models = CURSOR_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({
      toolId: 'cursor-agent',
      args: ['models'],
      ci: 'omit',
    });
    const parsed = await models?.parseOutput?.({
      ok: true,
      stdout: [
        'Available models',
        '',
        'auto - Auto',
        'composer-2.5-fast - Composer 2.5 Fast (current, default)',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
    expect(parsed).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
    ]);
  });
});
