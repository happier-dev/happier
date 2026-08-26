import { describe, expect, it } from 'vitest';

import {
  GROK_PREFLIGHT_SESSION_CONTROLS,
  parseGrokModelsOutput,
} from './models.js';

describe('parseGrokModelsOutput', () => {
  it('returns only provider-advertised model identities from the Grok models command', () => {
    expect(parseGrokModelsOutput(`
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
    grok-code-fast-1
`)).toEqual([
      { id: 'grok-4.5', name: 'Grok 4.5' },
      { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
    ]);
  });

  it('fails closed for missing, malformed, or duplicate model rows', () => {
    expect(parseGrokModelsOutput('Available models:\n')).toBeNull();
    expect(parseGrokModelsOutput('Available models:\n  * ../../bad (default)')).toBeNull();
    expect(parseGrokModelsOutput('Available models:\n  * grok-4.5\n  grok-4.5')).toBeNull();
  });
});

describe('GROK_PREFLIGHT_SESSION_CONTROLS', () => {
  it('declares the native command while leaving execution to the host', async () => {
    const models = GROK_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({
      toolId: 'grok-cli',
      args: ['models'],
      ci: 'omit',
    });
    await expect(models?.parseOutput?.({
      ok: true,
      stdout: 'Available models:\n  * grok-4.5 (default)\n',
      stderr: '',
      exitCode: 0,
    })).resolves.toEqual([{ id: 'grok-4.5', name: 'Grok 4.5' }]);
  });
});
