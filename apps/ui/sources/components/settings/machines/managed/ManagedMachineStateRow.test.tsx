import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
afterEach(() => standardCleanup());

describe('managed lifecycle presentation', () => {
  it('never words an accepted or unknown outcome as done', async () => {
    const { describeManagedLifecycleState } =
      await import('./managedLifecyclePresentation');
    const pending = describeManagedLifecycleState({ kind: 'stopPending' });
    expect(pending.tone).toBe('pending');
    expect(pending.line).toBe(
      'Stop requested. Stopping hasn’t been confirmed.',
    );
    const cleanup = describeManagedLifecycleState({
      kind: 'cleanupPending',
      reason: 'Hetzner returned 503.',
    });
    expect(cleanup.tone).toBe('danger');
    expect(cleanup.line).toContain('Provider charges may continue');
    expect(cleanup.line).not.toMatch(/\bdeleted\b/i);
    const missing = describeManagedLifecycleState({
      kind: 'localMissing',
      controller: 'MacBook Pro',
    });
    expect(missing.line).toContain('Confirm it’s gone');
    expect(missing.actions).toEqual(['checkNow']);
  });

  it.each(['cleanupPending', 'cleanupUnknown', 'creationCanceledCleanup'] as const)('offers console recovery only when its owner supplies a handler (%s)', async kind => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const pressed: string[] = [];
    const screen = await renderScreen(
      <ManagedMachineStateRow
        testID="row"
        name="hz-build-0"
        mark={null}
        provider="Hetzner"
        state={{ kind }}
        handlers={{}}
      />,
    );
    expect(screen.findByTestId('row:openProvider')).toBeNull();
    await screen.update(<ManagedMachineStateRow testID="row" name="hz-build-0" mark={null}
      provider="Hetzner" state={{ kind }} handlers={{ openProvider: () => pressed.push('openProvider') }} />);
    await act(async () => {
      screen.pressByTestId('row:openProvider');
    });
    expect(pressed).toEqual(['openProvider']);
  });
});
