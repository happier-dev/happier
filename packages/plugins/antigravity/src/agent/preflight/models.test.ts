import { describe, expect, it } from 'vitest';

import {
  ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS,
  buildAntigravityPreflightModelsFromModelsOutput,
} from './models.js';

describe('Antigravity preflight model parsing', () => {
  it('parses the observed agy models output into provider-owned model descriptors', () => {
    expect(buildAntigravityPreflightModelsFromModelsOutput([
      '  Gemini 3.5 Flash (Medium)',
      '  Gemini 3.5 Flash (High)',
      '  Claude Sonnet 4.6 (Thinking)',
    ].join('\n'))).toEqual([
      { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)' },
      { id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)' },
      { id: 'Claude Sonnet 4.6 (Thinking)', name: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('declares the bounded command and interprets host-bounded stdout or stderr', async () => {
    const models = ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({
      toolId: 'antigravity-cli',
      args: ['models'],
      environmentExcludeKeys: expect.arrayContaining(['GEMINI_API_KEY']),
    });
    await expect(models?.parseOutput?.({
      ok: true,
      stdout: '',
      stderr: 'Gemini 3.5 Flash (Medium)\n',
      exitCode: 0,
    })).resolves.toEqual([
      { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)' },
    ]);
  });
});
