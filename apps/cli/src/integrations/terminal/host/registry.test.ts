import { describe, expect, it } from 'vitest';

import { createTerminalHostRegistry } from './registry';
import type { TerminalHostAdapter } from './_types';

function adapter(kind: 'tmux' | 'zellij'): TerminalHostAdapter {
  return {
    kind,
    createOrAttachHost: async () => {
      throw new Error('not used');
    },
    injectUserPrompt: async () => {
      throw new Error('not used');
    },
    interruptTurn: async () => {
      throw new Error('not used');
    },
    evaluateLiveness: async () => ({ paneAlive: true, observedAt: 0 }),
    dispose: async () => {},
  };
}

describe('createTerminalHostRegistry', () => {
  it('indexes adapters by terminal host kind', () => {
    expect(createTerminalHostRegistry([adapter('tmux'), adapter('zellij')])).toMatchObject({
      tmux: { kind: 'tmux' },
      zellij: { kind: 'zellij' },
    });
  });
});
