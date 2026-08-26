import { describe, expect, it } from 'vitest';

import {
  buildOpenCodePreflightModelsFromVerboseOutput,
  OPENCODE_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

describe('OpenCode preflight model parsing', () => {
  it('retains provider-native model metadata from verbose output', () => {
    expect(buildOpenCodePreflightModelsFromVerboseOutput([
      'openai/gpt-5.4',
      '{',
      '  "id": "gpt-5.4",',
      '  "name": "GPT-5.4",',
      '  "providerID": "openai",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "input": { "text": true }, "reasoning": true },',
      '  "variants": { "medium": {}, "high": {} }',
      '}',
    ].join('\n'))).toEqual([
      expect.objectContaining({ id: 'openai/gpt-5.4', name: 'GPT-5.4' }),
    ]);
  });

  it('declares verbose then plain native commands without a plugin timeout or auth policy', () => {
    const models = OPENCODE_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({ toolId: 'opencode-cli', args: ['models', '--verbose'] });
    expect(models?.fallback?.command).toEqual({ toolId: 'opencode-cli', args: ['models'] });
    expect(OPENCODE_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('failureCacheStrategy');
    expect(OPENCODE_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('connectedServiceAuth');
  });

  it('lets the host select the fallback after an unparsable verbose result', async () => {
    const models = OPENCODE_PREFLIGHT_SESSION_CONTROLS.models;
    await expect(models?.parseOutput?.({
      ok: true,
      stdout: 'not verbose model output',
      stderr: '',
      exitCode: 0,
    })).resolves.toBeNull();
    await expect(models?.fallback?.parseOutput?.({
      ok: true,
      stdout: 'openai/gpt-5.4\nanthropic/claude-opus-5\n',
      stderr: '',
      exitCode: 0,
    })).resolves.toEqual([
      { id: 'openai/gpt-5.4', name: 'openai/gpt-5.4' },
      { id: 'anthropic/claude-opus-5', name: 'anthropic/claude-opus-5' },
    ]);
  });
});
