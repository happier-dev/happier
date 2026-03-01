import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '../domains/state/storageTypes';

vi.mock('@/text', () => ({
  t: (key: string) => key,
  tLoose: (key: string) => key,
}));

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    path: '/tmp',
    host: 'h',
    ...overrides,
  } as Metadata;
}

describe('sessionModeControl', () => {
  it('supportsSessionModeOverrides reflects agent catalog intent', async () => {
    const { supportsSessionModeOverrides } = await import('./sessionModeControl');
    expect(supportsSessionModeOverrides('opencode')).toBe(true);
    expect(supportsSessionModeOverrides('claude')).toBe(true);
    expect(supportsSessionModeOverrides('codex')).toBe(false);
  });

  it('computeSessionModePickerControl returns ACP modes and effective selection', async () => {
    const { computeSessionModePickerControl } = await import('./sessionModeControl');
    const metadata = createMetadata({
      acpSessionModesV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 1,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build', description: 'Do the work' },
          { id: 'plan', name: 'Plan', description: 'Think first' },
        ],
      },
    });

    const res = computeSessionModePickerControl({ agentId: 'opencode', metadata });
    expect(res).not.toBeNull();
    expect(res?.currentModeId).toBe('build');
    expect(res?.effectiveModeId).toBe('build');
    expect(res?.options.map((option) => option.id)).toEqual(['build', 'plan']);
  });

  it('computeSessionModePickerControl marks pending when requested override differs from current (ACP)', async () => {
    const { computeSessionModePickerControl } = await import('./sessionModeControl');
    const metadata = createMetadata({
      acpSessionModesV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 1,
        currentModeId: 'build',
        availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
      },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
    });

    const res = computeSessionModePickerControl({ agentId: 'opencode', metadata });
    expect(res?.effectiveModeId).toBe('plan');
    expect(res?.isPending).toBe(true);
    expect(res?.requestedModeId).toBe('plan');
  });

  it('computeSessionModePickerControl supports static modes (Claude)', async () => {
    const { computeSessionModePickerControl } = await import('./sessionModeControl');
    const metadata = createMetadata();
    const res = computeSessionModePickerControl({ agentId: 'claude', metadata });
    expect(res).not.toBeNull();
    expect(res?.currentModeId).toBe('default');
    expect(res?.effectiveModeId).toBe('default');
    // Names are translated via mocked t() above.
    expect(res?.options.map((o) => o.id)).toContain('plan');
  });

  it('computeSessionModePickerControl treats legacy permissionMode=plan as requested plan mode', async () => {
    const { computeSessionModePickerControl } = await import('./sessionModeControl');
    const metadata = createMetadata({ permissionMode: 'plan', permissionModeUpdatedAt: 10 } as any);
    const res = computeSessionModePickerControl({ agentId: 'claude', metadata });
    expect(res?.requestedModeId).toBe('plan');
    expect(res?.effectiveModeId).toBe('plan');
  });
});
