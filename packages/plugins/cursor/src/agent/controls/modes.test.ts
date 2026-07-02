import { describe, expect, it } from 'vitest';

import { buildCursorPlanModePrompt, resolveCursorModeValue } from './modes.js';

describe('cursor modes', () => {
  it('maps canonical mode ids to Cursor ACP mode values', () => {
    expect(resolveCursorModeValue('plan')).toBe('plan');
    expect(resolveCursorModeValue('ask')).toBe('ask');
    expect(resolveCursorModeValue('agent')).toBe('agent');
  });

  it('uses a provider-owned plan fallback prefix when native plan mode is unavailable', () => {
    expect(buildCursorPlanModePrompt('Inspect this repo')).toContain('Inspect this repo');
    expect(buildCursorPlanModePrompt('Inspect this repo')).toContain('plan');
  });
});
