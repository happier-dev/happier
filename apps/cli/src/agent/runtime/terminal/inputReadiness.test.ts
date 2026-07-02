import { describe, expect, it } from 'vitest';

import { resolveTerminalInputReadiness } from './inputReadiness';

describe('resolveTerminalInputReadiness', () => {
  it('allows writable running turns when no guard is active', () => {
    expect(resolveTerminalInputReadiness({
      turnState: { state: 'running', turnId: 'turn-1', source: 'hook' },
      hostLiveness: { paneAlive: true, observedAt: 100 },
      inputState: { stable: true, currentInput: '', observedAt: 101 },
      providerSessionId: 'provider-session-1',
      observedAt: 102,
    })).toEqual({
      status: 'writable',
      observedAt: 102,
      activeTurnId: 'turn-1',
      providerSessionId: 'provider-session-1',
      liveness: { paneAlive: true, observedAt: 100 },
    });
  });

  it('defers permission, user typing, and finalizing before reporting writable', () => {
    const base = {
      turnState: { state: 'running', turnId: 'turn-1', source: 'hook' } as const,
      hostLiveness: { paneAlive: true, observedAt: 100 },
      inputState: { stable: true, currentInput: '', observedAt: 101 },
      observedAt: 102,
    };

    expect(resolveTerminalInputReadiness({ ...base, permissionBlocked: true })).toMatchObject({ status: 'defer_permission' });
    expect(resolveTerminalInputReadiness({ ...base, inputState: { stable: false, currentInput: 'typing', observedAt: 103 } })).toMatchObject({ status: 'defer_user_typing' });
    expect(resolveTerminalInputReadiness({ ...base, finalizing: true })).toMatchObject({ status: 'defer_finalizing' });
  });

  it('requires provider confirmation for ambiguous injection failures', () => {
    expect(resolveTerminalInputReadiness({
      turnState: { state: 'unknown', reason: 'after host write' },
      hostLiveness: { paneAlive: true, observedAt: 100 },
      inputState: { stable: true, currentInput: '', observedAt: 101 },
      lastInjectionResult: {
        status: 'failed',
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: false,
        observedAt: 102,
      },
      observedAt: 103,
    })).toMatchObject({
      status: 'failed_ambiguous',
      duplicateRisk: 'likely',
      recoverable: false,
      reason: 'timeout',
    });
  });

  it('treats possible duplicate injection as ambiguous even when the terminal write is recoverable', () => {
    expect(resolveTerminalInputReadiness({
      turnState: { state: 'unknown', reason: 'after host write' },
      hostLiveness: { paneAlive: true, observedAt: 100 },
      inputState: { stable: true, currentInput: '', observedAt: 101 },
      lastInjectionResult: {
        status: 'failed',
        reason: 'host_unreachable',
        phase: 'after_write_before_enter',
        duplicateRisk: 'possible',
        recoverable: true,
        observedAt: 102,
      },
      observedAt: 103,
    })).toMatchObject({
      status: 'failed_ambiguous',
      duplicateRisk: 'possible',
      recoverable: true,
      reason: 'host_unreachable',
    });
  });

  it('separates provider-starting and awaiting-acceptance from terminal failures', () => {
    const base = {
      turnState: { state: 'running', source: 'hook' } as const,
      hostLiveness: { paneAlive: true, observedAt: 100 },
      inputState: { stable: true, currentInput: '', observedAt: 101 },
      observedAt: 102,
    };

    expect(resolveTerminalInputReadiness({ ...base, providerStarting: true })).toMatchObject({ status: 'defer_provider_starting' });
    expect(resolveTerminalInputReadiness({ ...base, awaitingProviderAcceptance: true })).toMatchObject({ status: 'awaiting_provider_acceptance' });
    expect(resolveTerminalInputReadiness({ ...base, hostLiveness: { paneAlive: false, paneDead: true, observedAt: 104 } })).toMatchObject({ status: 'failed_terminal' });
  });
});
