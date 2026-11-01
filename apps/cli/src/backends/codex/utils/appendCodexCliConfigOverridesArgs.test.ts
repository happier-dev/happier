import { expect, it } from 'vitest';

import { appendCodexCliConfigOverridesArgs } from './appendCodexCliConfigOverridesArgs';

it('places config overrides before the native end-of-options boundary', () => {
  expect(appendCodexCliConfigOverridesArgs(
    { command: 'codex', args: ['--config', 'model_reasoning_summary="detailed"', '--', 'prompt'] },
    ['model_reasoning_summary="auto"'],
  ).args).toEqual([
    '--config', 'model_reasoning_summary="detailed"',
    '-c', 'model_reasoning_summary="auto"', '--', 'prompt',
  ]);
});
