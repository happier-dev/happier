import { describe, expect, it } from 'vitest';

import { CODEX_TERMINAL_DISPLAY } from './display.js';

describe('CODEX_TERMINAL_DISPLAY', () => {
  it('preserves the Codex remote-control display provider label', () => {
    expect(CODEX_TERMINAL_DISPLAY).toEqual({ providerName: 'Codex' });
  });
});
