import { describe, expect, it } from 'vitest';

import { AUGGIE_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

describe('Auggie Agent preflight declaration', () => {
  it('declares public preflight command data without a private catalog contribution', () => {
    expect(AUGGIE_PREFLIGHT_SESSION_CONTROLS.models?.command).toEqual({
      toolId: 'auggie-cli',
      args: ['model', 'list', '--json'],
    });
  });
});
