import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle } from './_types';
import { probeTerminalHostForRecovery } from './recoveryLiveness';

const handle: TerminalHostHandle = {
  kind: 'zellij',
  sessionName: 'session-a',
  paneId: 'terminal_1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

function buildAdapter(evaluateLiveness: TerminalHostAdapter['evaluateLiveness']): TerminalHostAdapter {
  return {
    kind: 'zellij',
    createOrAttachHost: vi.fn(),
    injectUserPrompt: vi.fn(),
    interruptTurn: vi.fn(),
    evaluateLiveness,
    dispose: vi.fn(),
  };
}

describe('terminal host recovery liveness', () => {
  it('keeps repeated probe failures inconclusive instead of inventing death evidence', async () => {
    const adapter = buildAdapter(vi.fn(async () => {
      throw new Error('list-panes timed out');
    }));

    await expect(probeTerminalHostForRecovery({ adapter, handle })).resolves.toMatchObject({
      status: 'inconclusive',
      probeCount: 2,
      liveness: {
        paneAlive: false,
        probeInconclusive: true,
      },
    });
    expect(adapter.evaluateLiveness).toHaveBeenCalledTimes(2);
  });

  it('requires explicit pane-dead evidence before classifying the host as dead', async () => {
    const uncertainAdapter = buildAdapter(vi.fn(async () => ({
      paneAlive: false,
      observedAt: 1,
    })));
    const deadAdapter = buildAdapter(vi.fn(async () => ({
      paneAlive: false,
      paneDead: true,
      paneExitStatus: 1,
      observedAt: 2,
    })));

    await expect(probeTerminalHostForRecovery({ adapter: uncertainAdapter, handle })).resolves.toMatchObject({
      status: 'inconclusive',
      probeCount: 2,
    });
    await expect(probeTerminalHostForRecovery({ adapter: deadAdapter, handle })).resolves.toMatchObject({
      status: 'dead',
      probeCount: 1,
    });
  });

  it('accepts a live second probe after an inconclusive first observation', async () => {
    const adapter = buildAdapter(vi.fn()
      .mockResolvedValueOnce({
        paneAlive: false,
        probeInconclusive: true,
        observedAt: 1,
      })
      .mockResolvedValueOnce({
        paneAlive: true,
        observedAt: 2,
      }));

    await expect(probeTerminalHostForRecovery({ adapter, handle })).resolves.toMatchObject({
      status: 'alive',
      probeCount: 2,
    });
  });
});
