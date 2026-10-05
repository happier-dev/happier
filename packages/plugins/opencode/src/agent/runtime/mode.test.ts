import { describe, expect, it } from 'vitest';

import { resolveOpenCodeBackendMode } from './mode.js';
import { createOpenCodeAgentRuntime } from './nativeRuntime.js';

describe('resolveOpenCodeBackendMode for execution runs', () => {
  it.each(['plain', undefined, 'herdr', 'zellij', 'tmux'] as const)(
    'keeps shared attach available without starting an invisible client for host %s',
    async (requestedHost) => {
      const runtime = await createOpenCodeAgentRuntime({
        plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        agent: { id: 'opencode' }, signal: new AbortController().signal,
      });
      if (!runtime.sessions?.resolveTerminalPresentation) throw new Error('OpenCode presentation owner is unavailable');
      const selected = await runtime.sessions.resolveTerminalPresentation({
        requestedHost,
        launchEnvironment: { values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' } },
      }, {
        settings: { forScope() { throw new Error('Explicit OpenCode selection must not read account settings'); } },
        features: { isEnabled() { throw new Error('Explicit OpenCode selection must not read feature policy'); } },
      });
      expect(selected).toMatchObject({
        kind: 'provider_attach',
        startingMode: requestedHost === 'plain' || requestedHost === undefined ? 'remote' : 'terminal',
        runtimeDescriptorV1: { agentId: 'opencode', agent: { backendMode: 'server' } },
        environmentOverlay: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
      });
    },
  );

  it('keeps captured ACP headless even when a terminal host is selected', async () => {
    const runtime = await createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' }, signal: new AbortController().signal,
    });
    const selected = await runtime.sessions?.resolveTerminalPresentation?.({
      requestedHost: 'herdr',
      runtimeDescriptorV1: { v: 1, agentId: 'opencode', agent: { backendMode: 'acp' } },
      launchEnvironment: { values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' } },
    }, {
      settings: { forScope() { throw new Error('Captured OpenCode selection must not read account settings'); } },
      features: { isEnabled() { throw new Error('Captured OpenCode selection must not read feature policy'); } },
    });
    expect(selected).toMatchObject({ kind: 'none', runtimeDescriptorV1: { agent: { backendMode: 'acp' } } });
    expect(selected?.startingMode).toBeUndefined();
  });

  it('honors explicit typed session mode over the ambient legacy launch environment', async () => {
    const runtime = await createOpenCodeAgentRuntime({ plugin: { id: 'happier.agent.opencode', version: '0.0.0' }, agent: { id: 'opencode' }, signal: new AbortController().signal });
    await expect(runtime.sessions?.resolveTerminalPresentation?.({
      configuration: {
        options: { opencodeBackendMode: { value: 'server', updatedAtMs: 1 } },
      },
      launchEnvironment: { values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' } },
    }, {
      settings: { forScope() { throw new Error('Explicit OpenCode runtime mode must not consult account settings'); } },
      features: { isEnabled() { throw new Error('Explicit OpenCode runtime mode must not consult feature policy'); } },
    })).resolves.toMatchObject({ kind: 'provider_attach', runtimeDescriptorV1: { agent: { backendMode: 'server' } } });
  });
  it('defaults OpenCode execution runs to server mode', () => {
    expect(resolveOpenCodeBackendMode({ env: undefined })).toBe('server');
  });

  it('lets execution-run isolation env prefer ACP over account settings', () => {
    expect(resolveOpenCodeBackendMode({
      env: { HAPPIER_OPENCODE_BACKEND_MODE: ' acp ' },
      accountSettings: {
        opencodeBackendMode: 'server',
      },
    })).toBe('acp');
  });

  it('uses account settings when no explicit env override is present', () => {
    expect(resolveOpenCodeBackendMode({
      env: {},
      accountSettings: {
        opencodeBackendMode: 'acp',
      },
    })).toBe('acp');
  });
});
