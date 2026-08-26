import { describe, expect, it } from 'vitest';

import {
  buildOhMyPiPreflightModelsFromListModelsOutput,
  OH_MY_PI_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

describe('OhMyPi preflight model parsing', () => {
  it('builds dynamic models with Thinking options from omp list-models output', () => {
    expect(buildOhMyPiPreflightModelsFromListModelsOutput([
      'provider      model                       context  max-out  thinking  images',
      'openai        gpt-5.4                     272K     128K     yes       yes',
      'anthropic     claude-3-7-sonnet-latest    200K     64K      no        yes',
    ].join('\n'))).toEqual([
      expect.objectContaining({ id: 'openai/gpt-5.4', modelOptions: expect.any(Array) }),
      { id: 'anthropic/claude-3-7-sonnet-latest', name: 'claude-3-7-sonnet-latest', description: 'anthropic' },
    ]);
  });

  it('fails closed for no-credential output and declares the static native command', async () => {
    expect(buildOhMyPiPreflightModelsFromListModelsOutput(
      'No models available. Set API keys in environment variables.\n',
    )).toBeNull();
    const models = OH_MY_PI_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({ toolId: 'ohmypi-cli', args: ['--list-models'] });
    await expect(models?.parseOutput?.({
      ok: true,
      stdout: 'openai  gpt-5.4  272K  128K  yes  yes\n',
      stderr: '',
      exitCode: 0,
    })).resolves.toEqual([expect.objectContaining({ id: 'openai/gpt-5.4' })]);
  });
});
