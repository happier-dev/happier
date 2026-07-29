import { describe, expect, it } from 'vitest';

import type { TerminalControlPort } from '@happier-dev/agents';

import { captureScreenState } from './controlRuntime.js';

const ESC = '\u001b';

function portWithCapture(capture: { text: string; styledText?: string }): TerminalControlPort {
  return {
    hostKind: 'tmux',
    async sendLiteralText() {
      return { status: 'sent', at: 0 };
    },
    async sendRawSequence() {
      return { status: 'sent', at: 0 };
    },
    async sendSpecialKey() {
      return { status: 'sent', at: 0 };
    },
    async captureScreen() {
      return { status: 'captured', capture: { ...capture, capturedAtMs: 0, hostKind: 'tmux' } };
    },
  };
}

describe('captureScreenState styled capture preference (ported S-8)', () => {
  it('parses the styled raw capture so the SGR-dim placeholder reads as an empty composer', async () => {
    // Live shape (remote-dev QA-B F6, Claude Code 2.1.174): empty-composer contextual suggestion
    // rendered DIM. Without styling info the text is indistinguishable from a typed draft.
    const styledText = `${ESC}[2m✻ Welcome${ESC}[22m\n❯ ${ESC}[2mcheck the output${ESC}[22m\n`;
    const outcome = await captureScreenState(portWithCapture({ text: '✻ Welcome\n❯ check the output', styledText }));

    expect(outcome.kind).toBe('state');
    if (outcome.kind !== 'state') throw new Error('expected state');
    expect(outcome.state.composerContent).toBe('');
    expect(outcome.state.userDraftPresent).toBe(false);
  });

  it('fails closed to draft semantics when only a plain capture is available', async () => {
    const outcome = await captureScreenState(portWithCapture({ text: '✻ Welcome\n❯ check the output' }));

    expect(outcome.kind).toBe('state');
    if (outcome.kind !== 'state') throw new Error('expected state');
    expect(outcome.state.composerContent).toBe('check the output');
    expect(outcome.state.userDraftPresent).toBe(true);
  });
});
