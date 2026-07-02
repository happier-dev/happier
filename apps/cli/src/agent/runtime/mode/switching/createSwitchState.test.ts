import { describe, expect, it } from 'vitest';

import { createAgentRuntimeSwitchState } from './createSwitchState';

describe('createAgentRuntimeSwitchState', () => {
  it('does not infer remote writeability from shared topology', () => {
    expect(createAgentRuntimeSwitchState({
      attached: true,
      topology: 'shared',
    })).toMatchObject({
      attached: true,
      topology: 'shared',
      remoteWritable: false,
    });
  });

  it('keeps remote writeability explicit when the provider capability grants it', () => {
    expect(createAgentRuntimeSwitchState({
      attached: true,
      topology: 'shared',
      remoteWritable: true,
    })).toMatchObject({
      attached: true,
      topology: 'shared',
      remoteWritable: true,
    });
  });
});
