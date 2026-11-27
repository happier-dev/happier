import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId } from '@/agent/core';

const { createAcpBackend } = vi.hoisted(() => ({ createAcpBackend: vi.fn() }));

vi.mock('@/agent/acp/createAcpBackend', () => ({ createAcpBackend }));
vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: () => ({ command: '/usr/local/bin/devin', args: [] }),
}));

import { createCatalogDefinedAcpBackend } from './createCatalogDefinedAcpBackend';

// The catalog wrapper routes `setSessionMode` through the shared mode resolution, so assertions
// observe the native ACP write it delegates to.
function createBackend(): AgentBackend & {
  setSessionMode: ReturnType<typeof vi.fn>;
  nativeSetSessionMode: ReturnType<typeof vi.fn>;
} {
  const nativeSetSessionMode = vi.fn(async () => {});
  return {
    startSession: vi.fn(async () => ({ sessionId: 'started' as SessionId })),
    loadSession: vi.fn(async (sessionId: SessionId) => ({ sessionId })),
    sendPrompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onMessage: vi.fn(),
    dispose: vi.fn(async () => {}),
    setSessionMode: nativeSetSessionMode,
    nativeSetSessionMode,
  };
}

describe('createCatalogDefinedAcpBackend (Devin)', () => {
  beforeEach(() => {
    createAcpBackend.mockReset();
  });

  it('does not force a Devin permission mode for Happier default', async () => {
    const backend = createBackend();
    createAcpBackend.mockReturnValue(backend);

    const created = createCatalogDefinedAcpBackend('devin' as never, {
      cwd: '/workspace',
      permissionMode: 'default',
      mcpServers: { happier: { command: 'happier-mcp' } },
    });

    await created.startSession();

    expect(backend.nativeSetSessionMode).not.toHaveBeenCalled();
    expect(createAcpBackend).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: undefined }));
  });

  it('forwards provider-owned process launch preparation to the ACP backend', () => {
    const backend = createBackend();
    const prepareProcessLaunch = vi.fn(async () => ({ env: { XDG_CONFIG_HOME: '/tmp/devin' } }));
    createAcpBackend.mockReturnValue(backend);

    createCatalogDefinedAcpBackend('devin' as never, {
      cwd: '/workspace',
      prepareProcessLaunch,
    });

    expect(createAcpBackend).toHaveBeenCalledWith(expect.objectContaining({ prepareProcessLaunch }));
  });

  it.each([
    ['read-only', 'normal'],
    ['safe-yolo', 'accept-edits'],
    ['yolo', 'dangerous'],
    ['plan', null],
  ] as const)('applies explicit Happier mode %s as Devin ACP mode %s before returning', async (permissionMode, devinMode) => {
    const backend = createBackend();
    createAcpBackend.mockReturnValue(backend);

    const created = createCatalogDefinedAcpBackend('devin' as never, {
      cwd: '/workspace',
      permissionMode,
    });

    await created.startSession();

    if (devinMode === null) {
      expect(backend.nativeSetSessionMode).not.toHaveBeenCalled();
    } else {
      expect(backend.nativeSetSessionMode).toHaveBeenCalledWith('started', devinMode);
    }
  });

  it('reapplies the explicit Devin mode after loading a vendor session', async () => {
    const backend = createBackend();
    createAcpBackend.mockReturnValue(backend);

    const created = createCatalogDefinedAcpBackend('devin' as never, {
      cwd: '/workspace',
      permissionMode: 'read-only',
    });

    await created.loadSession?.('resumed' as SessionId);

    expect(backend.nativeSetSessionMode).toHaveBeenCalledWith('resumed', 'normal');
  });

  it('resolves a persisted Devin mode override through the permission selector', async () => {
    const backend = createBackend();
    createAcpBackend.mockReturnValue(backend);

    const created = createCatalogDefinedAcpBackend('devin' as never, {
      cwd: '/workspace',
      permissionMode: 'read-only',
    }) as ReturnType<typeof createCatalogDefinedAcpBackend> & {
      setSessionMode: (sessionId: SessionId, modeId: string) => Promise<void>;
    };

    await created.setSessionMode('resumed' as SessionId, 'dangerous');

    expect(backend.nativeSetSessionMode).toHaveBeenCalledTimes(1);
    expect(backend.nativeSetSessionMode).toHaveBeenCalledWith('resumed', 'normal');
  });
});
