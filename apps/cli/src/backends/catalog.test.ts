import { describe, expect, it } from 'vitest';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore } from '@happier-dev/agents';

import {
  AGENTS,
  getAcpForkContinuationHandler,
  getConnectedServicesMaterializer,
  getDirectSessionProviderOps,
  getManagedServerLaunchSpec,
  normalizeSessionControlPermissionModeForBackendTarget,
  getProviderAttachOps,
  getProviderNativeForkHandler,
  resolveBackendEngineAdapterResolution,
  getSessionHandoffProviderOps,
  getTerminalRuntimeOps,
  getVendorResumeSupport,
  requireCatalogEntry,
} from './catalog';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import { DEFAULT_CATALOG_AGENT_ID } from './types';

describe('AGENTS', () => {
  it('includes kilo', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'kilo')).toBe(true);
  });

  it('includes pi', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'pi')).toBe(true);
  });

  it('includes ohMyPi', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'ohMyPi')).toBe(true);
  });

  it('has unique cliSubcommand values', () => {
    const values = Object.values(AGENTS).map((entry) => entry.cliSubcommand);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keys match entry ids', () => {
    for (const [key, entry] of Object.entries(AGENTS)) {
      expect(key).toBe(entry.id);
    }
  });

  it('throws when requiring a missing catalog entry (no silent default fallback)', () => {
    expect(() => requireCatalogEntry('__missing__' as any)).toThrow(/missing catalog agent entry/i);
  });

  it('declares vendor resume support for every agent', () => {
    for (const id of AGENT_IDS) {
      const entry = requireCatalogEntry(id);
      expect(entry.vendorResumeSupport).toBe(getAgentCore(id).resume.vendorResume);
    }
  });

  it('resolves built-in ACP ohMyPi vendor resume support as enabled', async () => {
    const supportsResume = await getVendorResumeSupport('ohMyPi');
    expect(supportsResume({})).toBe(true);
  });

  it('matches shared agent ids', () => {
    const keys = Object.keys(AGENTS).slice().sort();
    const shared = [...AGENT_IDS].slice().sort();
    expect(keys).toEqual(shared);
  });

  it('uses the shared default agent id', () => {
    expect(DEFAULT_CATALOG_AGENT_ID).toBe(DEFAULT_AGENT_ID);
  });

  it('keeps cloud connect config in sync with catalog entries', async () => {
    for (const id of AGENT_IDS) {
      const core = getAgentCore(id);
      const entry = requireCatalogEntry(id);

      if (core.cloudConnect) {
        expect(entry.getCloudConnectTarget).toBeTruthy();
        const target = await entry.getCloudConnectTarget!();
        expect(target.vendorKey).toBe(core.cloudConnect.vendorKey);
        expect(target.status).toBe(core.cloudConnect.status);
      } else {
        expect(entry.getCloudConnectTarget).toBeFalsy();
      }
    }
  });

  it('forces remote starting mode for claude headless tmux sessions', async () => {
    const transform = await requireCatalogEntry('claude').getHeadlessTmuxArgvTransform!();
    expect(transform(['--foo'])).toEqual(['--foo', '--happy-starting-mode', 'remote']);
  });

  it('exposes a preflight session-controls probe adapter for claude so model-scoped options can be surfaced without ACP', async () => {
    const entry = requireCatalogEntry('claude');
    expect(entry.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
    const adapter = await entry.getPreflightSessionControlsProbeAdapter!();
    expect(adapter).toMatchObject({
      probeModelsRaw: expect.any(Function),
    });
  });

  it('declares opencode CLI model probing through the backend catalog', async () => {
    const entry = requireCatalogEntry('opencode');
    expect(entry.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
    const adapter = await entry.getPreflightSessionControlsProbeAdapter!();
    expect(adapter).toMatchObject({
      failureCacheStrategy: 'cooldown',
      cliModelsCommandArgs: ['models', '--verbose'],
    });
  });

  it('does not define a headless tmux argv transform for codex', () => {
    expect(requireCatalogEntry('codex').getHeadlessTmuxArgvTransform).toBeUndefined();
  });

  it('registers runnable CLI command handlers for canonical built-in generic ACP agents', () => {
    expect(requireCatalogEntry('kiro').getCliCommandHandler).toBeTypeOf('function');
    expect(requireCatalogEntry('ohMyPi').getCliCommandHandler).toBeTypeOf('function');
  });

  it('loads direct-session provider ops through backend catalog hooks', async () => {
    await expect(getDirectSessionProviderOps('claude')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
      pageTranscript: expect.any(Function),
      readAfterTranscript: expect.any(Function),
      validateSource: expect.any(Function),
      getActivity: expect.any(Function),
      acquireFollowLease: expect.any(Function),
      resolveTakeoverSpawnOptions: expect.any(Function),
    });
    await expect(getDirectSessionProviderOps('codex')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
      validateSource: expect.any(Function),
      acquireFollowLease: expect.any(Function),
    });
    await expect(getDirectSessionProviderOps('opencode')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
    });
    await expect(getDirectSessionProviderOps('ohMyPi')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
      validateSource: expect.any(Function),
      pageTranscript: expect.any(Function),
      readAfterTranscript: expect.any(Function),
      acquireFollowLease: expect.any(Function),
      resolveTakeoverSpawnOptions: expect.any(Function),
    });
  });

  it('loads connected-services materializers through backend catalog hooks for supporting providers', async () => {
    await expect(getConnectedServicesMaterializer('claude')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('codex')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('gemini')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('opencode')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('pi')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('ohMyPi')).resolves.toBeTypeOf('function');
  });

  it('loads managed-server launch specs through backend catalog hooks for supporting providers', async () => {
    await expect(getManagedServerLaunchSpec('opencode')).resolves.toMatchObject({
      command: expect.any(String),
      args: expect.any(Array),
    });
  });

  it('loads provider-attach ops through backend catalog hooks only for supporting providers', async () => {
    await expect(getProviderAttachOps('opencode')).resolves.toMatchObject({
      evaluateEligibility: expect.any(Function),
      runAttach: expect.any(Function),
    });
    await expect(getProviderAttachOps('claude')).resolves.toBeNull();
  });

  it('loads provider-native fork handlers through backend catalog hooks only for supporting providers', async () => {
    await expect(getProviderNativeForkHandler('codex')).resolves.toBeTypeOf('function');
    await expect(getProviderNativeForkHandler('opencode')).resolves.toBeTypeOf('function');
    await expect(getProviderNativeForkHandler('claude')).resolves.toBeNull();
  });

  it('loads session-handoff provider ops through backend catalog hooks only for supporting providers', async () => {
    await expect(getSessionHandoffProviderOps('claude')).resolves.toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    await expect(getSessionHandoffProviderOps('codex')).resolves.toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    await expect(getSessionHandoffProviderOps('opencode')).resolves.toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    await expect(getSessionHandoffProviderOps('ohMyPi')).resolves.toBeNull();
  });

  it('loads ACP fork continuation handlers through backend catalog hooks only for supporting providers', async () => {
    await expect(getAcpForkContinuationHandler('codex')).resolves.toBeTypeOf('function');
    await expect(getAcpForkContinuationHandler('opencode')).resolves.toBeTypeOf('function');
    await expect(getAcpForkContinuationHandler('claude')).resolves.toBeNull();
  });

  it('normalizes session-control permission modes through provider-owned catalog seams', () => {
    expect(
      normalizeSessionControlPermissionModeForBackendTarget({
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'safe-yolo',
      }),
    ).toBe('acceptEdits');

    expect(
      normalizeSessionControlPermissionModeForBackendTarget({
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        permissionMode: 'safe-yolo',
      }),
    ).toBe('safe-yolo');
  });

  it('resolves built-in backends through the canonical engine-adapter record', async () => {
    const resolution = await resolveBackendEngineAdapterResolution('codex');
    expect(resolution).toMatchObject({
      backendId: 'codex',
      providerId: 'codex',
      provenance: 'first_party',
      backend: {
        id: 'codex',
      },
      provider: {
        id: 'codex',
      },
      executionSurfaces: {
        terminalRuntime: expect.anything(),
      },
      diagnostics: [],
    });
    expect(resolution?.selectedSource === 'system' || resolution?.selectedSource === 'managed').toBe(true);
  });
});
