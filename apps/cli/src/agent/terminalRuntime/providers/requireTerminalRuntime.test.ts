import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';

const { resolveBackendExecutionSurfaces, getTerminalRuntimeOps } = vi.hoisted(() => ({
  resolveBackendExecutionSurfaces: vi.fn(),
  getTerminalRuntimeOps: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces,
  getTerminalRuntimeOps,
}));

import { requireTerminalRuntimeResolveTranscriptBinding } from './resolveTranscriptBinding';
import { requireTerminalRuntimeLaunch } from './requireTerminalRuntimeLaunch';

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockLocalHostedDirectTranscriptBinding(): LocalHostedDirectTranscriptBinding {
  return {
    providerId: 'codex',
    source: {
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/runtime-binding',
    },
    remoteSessionId: 'runtime-binding',
  };
}

describe('terminal runtime requirement helpers', () => {
  it('resolve launch through the generic backend execution surface', async () => {
    const launch = vi.fn(async () => 'launched');
    resolveBackendExecutionSurfaces.mockResolvedValue({
      terminalRuntime: {
        launch,
      },
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });
    getTerminalRuntimeOps.mockReset();

    const resolvedLaunch = await requireTerminalRuntimeLaunch('acme.runtime.backend');
    await expect(resolvedLaunch({})).resolves.toBe('launched');

    expect(resolveBackendExecutionSurfaces).toHaveBeenCalledWith('acme.runtime.backend');
    expect(getTerminalRuntimeOps).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith({});
  });

  it('resolve transcript binding through the generic backend execution surface', async () => {
    const binding = createMockLocalHostedDirectTranscriptBinding();
    const resolveTranscriptBinding = vi.fn(async () => binding);
    resolveBackendExecutionSurfaces.mockResolvedValue({
      terminalRuntime: {
        resolveTranscriptBinding,
      },
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });
    getTerminalRuntimeOps.mockReset();

    const resolvedTranscriptBinding = await requireTerminalRuntimeResolveTranscriptBinding('acme.runtime.backend');
    await expect(resolvedTranscriptBinding({})).resolves.toEqual({
      providerId: 'codex',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/tmp/runtime-binding',
      },
      remoteSessionId: 'runtime-binding',
    });

    expect(resolveBackendExecutionSurfaces).toHaveBeenCalledWith('acme.runtime.backend');
    expect(getTerminalRuntimeOps).not.toHaveBeenCalled();
    expect(resolveTranscriptBinding).toHaveBeenCalledWith({});
  });
});
