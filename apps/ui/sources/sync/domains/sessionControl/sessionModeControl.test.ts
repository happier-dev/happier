import { describe, expect, it, vi } from 'vitest';

import { serializeSessionModeActionOptions } from '@/sync/ops/actions/sessionModeActionSupport';

import type { Metadata } from '../state/storageTypes';
import { computeSessionModePickerControl, resolveRequestedSessionModeIdForMetadata, supportsSessionModeOverrides } from './sessionModeControl';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
    });
});

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    path: '/tmp',
    host: 'h',
    ...overrides,
  } as Metadata;
}

describe('sessionModeControl', () => {
  it('offers clear separately from a provider native Default mode', () => {
    const control = computeSessionModePickerControl({ agentId: 'codebuddy', metadata: createMetadata({
      sessionModesV1: { v: 1, provider: 'codebuddy', updatedAt: 1, currentModeId: 'plan', availableModes: [
        { id: 'default', name: 'Native Default' }, { id: 'plan', name: 'Plan' },
      ] },
      sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
    }) });
    expect(serializeSessionModeActionOptions(control).map((option) => option.value)).toEqual(['', 'default', 'plan']);
    expect(resolveRequestedSessionModeIdForMetadata(control, '')).toBe('');
    expect(resolveRequestedSessionModeIdForMetadata(control, 'default')).toBe('default');
  });

  it('does not offer mapped-policy reset for an unmapped native-mode provider', () => {
    const control = computeSessionModePickerControl({ agentId: 'opencode', metadata: createMetadata({
      sessionModesV1: { v: 1, provider: 'opencode', updatedAt: 1, currentModeId: 'default', availableModes: [
        { id: 'default', name: 'Native Default' }, { id: 'plan', name: 'Plan' },
      ] },
    }) });
    expect(serializeSessionModeActionOptions(control).map((option) => option.value)).toEqual(['default', 'plan']);
  });

  it('does not infer unadvertised Plan from a permission setting', async () => {
    const metadata = createMetadata({
      permissionMode: 'plan',
      sessionModesV1: { v: 1, provider: 'fx', updatedAt: 1, currentModeId: 'code', availableModes: [
        { id: 'code', name: 'Code' }, { id: 'ask', name: 'Ask' },
      ] },
    });
    expect(computeSessionModePickerControl({ agentId: 'fx', metadata })).toMatchObject({
      requestedModeId: null, effectiveModeId: 'code', isPending: false,
    });
    metadata.sessionModeOverrideV1 = { v: 1, updatedAt: 2, modeId: 'plan' };
    expect(computeSessionModePickerControl({ agentId: 'fx', metadata })).toMatchObject({
      requestedModeId: 'plan', effectiveModeId: 'plan', isPending: true,
    });
  });

  it('reads configured ACP modes only for the session backend', async () => {
    const metadata = createMetadata({
      acpConfiguredBackendV1: { v: 1, backendId: 'custom-one', title: 'Custom', updatedAt: 1 },
      sessionModesV1: { v: 1, provider: 'acp:custom-one', updatedAt: 1, currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }] },
    });
    expect(computeSessionModePickerControl({ agentId: 'customAcp', metadata })?.effectiveModeId).toBe('build');
    metadata.acpConfiguredBackendV1 = { v: 1, backendId: 'custom-two', title: 'Other', updatedAt: 2 };
    expect(computeSessionModePickerControl({ agentId: 'customAcp', metadata })).toBeNull();
  });

  it('supportsSessionModeOverrides reflects agent catalog intent', async () => {
    expect(supportsSessionModeOverrides('opencode')).toBe(true);
    expect(supportsSessionModeOverrides('claude')).toBe(true);
    expect(supportsSessionModeOverrides('codex')).toBe(true);
  });

  it('computeSessionModePickerControl returns ACP modes and effective selection', async () => {
    const metadata = createMetadata({
      sessionModesV1: {
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
    const metadata = createMetadata({
      sessionModesV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 1,
        currentModeId: 'build',
        availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
      },
      sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
    });

    const res = computeSessionModePickerControl({ agentId: 'opencode', metadata });
    expect(res?.effectiveModeId).toBe('plan');
    expect(res?.isPending).toBe(true);
    expect(res?.requestedModeId).toBe('plan');
  });

  it('computeSessionModePickerControl supports static modes (Claude)', async () => {
    const metadata = createMetadata();
    const res = computeSessionModePickerControl({ agentId: 'claude', metadata });
    expect(res).not.toBeNull();
    expect(res?.currentModeId).toBe('default');
    expect(res?.effectiveModeId).toBe('default');
    // Names are translated via mocked t() above.
    expect(res?.options.map((o) => o.id)).toContain('plan');
  });

  it('computeSessionModePickerControl treats legacy permissionMode=plan as requested plan mode', async () => {
    const metadata = createMetadata({ permissionMode: 'plan', permissionModeUpdatedAt: 10 } as any);
    const res = computeSessionModePickerControl({ agentId: 'claude', metadata });
    expect(res?.requestedModeId).toBe('plan');
    expect(res?.effectiveModeId).toBe('plan');
  });

  it('lets an explicit newer mode tombstone clear the legacy permission-mode fallback', async () => {
    const metadata = createMetadata({
      permissionMode: 'plan',
      permissionModeUpdatedAt: 10,
      acpSessionModeOverrideV1: { v: 1, updatedAt: 20, modeId: null },
    } as any);

    const res = computeSessionModePickerControl({ agentId: 'claude', metadata });
    expect(res?.requestedModeId).toBeNull();
    expect(res?.effectiveModeId).toBe('default');
  });

  it('falls back to legacy ACP metadata keys when canonical keys are absent', async () => {
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
  });

  it('computeSessionModePickerControl returns Codex app-server modes from generic session metadata', async () => {
    const metadata = createMetadata({
      sessionModesV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan', description: 'Think first' },
        ],
      },
      sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
    });

    const res = computeSessionModePickerControl({ agentId: 'codex', metadata });
    expect(res).not.toBeNull();
    expect(res?.effectiveModeId).toBe('plan');
    expect(res?.isPending).toBe(true);
    expect(res?.options.map((option) => option.id)).toEqual(['default', 'plan']);
  });

  it('publishes the real default mode id when the provider exposes default as an actual option', async () => {
    const metadata = createMetadata({
      sessionModesV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    });

    const control = computeSessionModePickerControl({ agentId: 'codex', metadata });
    expect(resolveRequestedSessionModeIdForMetadata(control, 'default')).toBe('default');
  });

  it('treats default as a clear sentinel when the provider does not expose a real default option', async () => {
    const metadata = createMetadata({
      sessionModesV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 1,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    });

    const control = computeSessionModePickerControl({ agentId: 'opencode', metadata });
    expect(resolveRequestedSessionModeIdForMetadata(control, 'default')).toBe('');
  });
});
