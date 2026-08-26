import { describe, expect, it } from 'vitest';

import {
  AUGGIE_PREFLIGHT_SESSION_CONTROLS,
  buildAuggiePreflightModelsFromModelListJson,
} from './models.js';

describe('Auggie preflight model probing', () => {
  it('parses Auggie model list JSON into preflight model descriptors', () => {
    expect(buildAuggiePreflightModelsFromModelListJson(JSON.stringify({
      models: [
        { displayName: 'Opus 4.8', shortName: 'opus4.8', description: 'Great for complex tasks' },
        { displayName: 'Haiku 4.5', shortName: 'haiku4.5' },
      ],
    }))).toEqual([
      { id: 'opus4.8', name: 'Opus 4.8', description: 'Great for complex tasks' },
      { id: 'haiku4.5', name: 'Haiku 4.5' },
    ]);
  });

  it('declares only its native command and parses the host result', async () => {
    const models = AUGGIE_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({ toolId: 'auggie-cli', args: ['model', 'list', '--json'] });
    await expect(models?.parseOutput?.({
      ok: true,
      stdout: JSON.stringify({ models: [{ displayName: 'Prism', shortName: 'prism-a' }] }),
      stderr: '',
      exitCode: 0,
    })).resolves.toEqual([{ id: 'prism-a', name: 'Prism' }]);
  });
});
