import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle } from './_types';
import { probeTerminalHostForRecovery } from './recoveryLiveness';
import { logger } from '@/ui/logger';

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
  it.each([
    { error: Object.assign(new Error('private-native-details'), { code: 'EACCES' }), code: 'EACCES', status: null },
    { error: Object.assign(new TypeError('private-native-details'), { response: { status: 429 } }), code: null, status: 429 },
    { error: Object.assign(new Error('private-native-details'), { code: 'private-error-code' }), code: null, status: null },
  ])('retains sanitized diagnostic cause for an inconclusive native probe ($code/$status)', async ({ error, code, status }) => {
    const diagnostic = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const result = await probeTerminalHostForRecovery({ handle, adapter: buildAdapter(async () => { throw error; }) });
      expect(result.status).toBe('inconclusive');
      expect(diagnostic).toHaveBeenCalledWith('[TERMINAL HOST] Recovery liveness probe failed', {
        failureCause: { phase: 'terminal_host.recovery_liveness', errorClass: error.name, errorCode: code, httpStatus: status },
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-');
    } finally { diagnostic.mockRestore(); }
  });

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
