import { describe, expect, it } from 'vitest';

import {
  buildPiPreflightModelsFromListModelsOutput,
  PI_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

describe('Pi preflight model parsing', () => {
  it('adds a Thinking option only for models that report thinking support', () => {
    expect(buildPiPreflightModelsFromListModelsOutput([
      'provider  model  context  max-out  thinking  images',
      'openai  gpt-5.4  200K  4K  yes  yes',
      'openai  gpt-4o-mini  128K  4K  no  yes',
    ].join('\n'))).toEqual([
      expect.objectContaining({ id: 'openai/gpt-5.4', modelOptions: expect.any(Array) }),
      { id: 'openai/gpt-4o-mini', name: 'gpt-4o-mini', description: 'openai' },
    ]);
  });

  it('declares the exact Pi environment allowlist and delegates command execution', async () => {
    const models = PI_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toMatchObject({
      toolId: 'pi-cli',
      args: ['--list-models'],
      environmentKeys: expect.arrayContaining(['OPENAI_API_KEY', 'CI']),
    });
    await expect(models?.parseOutput?.({
      ok: true,
      stdout: '',
      stderr: 'openai-codex  gpt-5.4  272K  128K  yes  yes\n',
      exitCode: 0,
    })).resolves.toEqual([expect.objectContaining({ id: 'openai-codex/gpt-5.4' })]);
  });
});
