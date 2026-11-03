import { describe, expect, it } from 'vitest';

import { findCommandDispatchDescriptor } from './commandRegistry';
import { isStaticCommandSurfaceReserved } from './commandDescriptors';

describe('internal Agent launch command', () => {
  it('reserves the exact shim command with a lazy, non-tmux handler', () => {
    expect(isStaticCommandSurfaceReserved('agent-launch')).toBe(true);
    expect(findCommandDispatchDescriptor('agent-launch')).toMatchObject({
      command: 'agent-launch',
      handler: expect.any(Function),
    });
  });
});
