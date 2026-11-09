import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { capabilityRpc } = vi.hoisted(() => ({ capabilityRpc: vi.fn(async (_machineId: any, _request: any, _options: any) => ({ ok: true as const, result: { availableModels: [{ id: 'model-a', name: 'Model A' }], supportsFreeform: false } })) }));

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
const probeCache = await import('@/sync/domains/models/dynamicModelProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicModelProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightModelsState', () => {
  it('passes params.cwd through to capabilities.invoke(cli.* probeModels)', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(() => expect(capabilityRpc).toHaveBeenCalledTimes(1));
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    const request = capabilityRpc.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      id: 'cli.opencode',
      method: 'probeModels',
      params: expect.objectContaining({ cwd: '/repo' }),
    });
  });

  it('probes a caller-named externally installed Agent under its own id', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'acme-external-agent' },
        runtimeCarrierAgentId: 'acme-external-agent' as never,
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(() => expect(capabilityRpc).toHaveBeenCalledTimes(1));
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    expect(capabilityRpc.mock.calls[0]?.[1]).toMatchObject({
      id: 'cli.acme-external-agent',
      method: 'probeModels',
    });
  });

  it('forwards probeContext.capabilityParams to capabilities.invoke(... probeModels)', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
        probeContext: {
          cacheKeySuffixParts: ['appServer'],
          capabilityParams: { profileId: 'profile-a' },
        },
      } as any);
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(() => expect(capabilityRpc).toHaveBeenCalledTimes(1));
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    const request = capabilityRpc.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      id: 'cli.codex',
      method: 'probeModels',
      params: expect.objectContaining({
        cwd: '/repo',
        profileId: 'profile-a',
      }),
    });
  });

  it('returns an idle empty state when no backend target is provided', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightModelsState({
        backendTarget: null as any,
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).not.toHaveBeenCalled();
    expect(latest.preflightModels).toBeNull();
    expect(latest.modelOptions).toEqual([]);
    expect(latest.probe.phase).toBe('idle');
  });

  it('uses the extended model-probe timeout for slow provider model discovery', async () => {
    const probeStartedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(probeStartedAt);
    try {
      capabilityRpc.mockClear();
      resetDynamicModelProbeCacheForTests();

      let latest: any = null;
      function Harness() {
        latest = useNewSessionPreflightModelsState({
          backendTarget: { kind: 'backend', backendId: 'codex' },
          selectedMachineId: 'machine-1',
          capabilityServerId: preflight.serverId,
          cwd: '/repo',
        });
        return null;
      }

      let root!: renderer.ReactTestRenderer;
      root = (await renderScreen(React.createElement(Harness))).tree;
      await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(latest.modelOptions.map((option: { value: string }) => option.value).slice(0, 2))
          .toEqual(['default', 'model-a']);
      });
      await act(async () => {
        root.unmount();
      });

      expect(capabilityRpc).toHaveBeenCalledTimes(1);
      const request = capabilityRpc.mock.calls[0]?.[1];
      const options = capabilityRpc.mock.calls[0]?.[2];
      expect(request?.params?.timeoutMs).toBe(NEW_SESSION_MODEL_PROBE_TIMEOUT_MS);
      expect(options?.timeoutMs).toBeNull();
      const values = (latest?.modelOptions ?? []).map((option: any) => option.value);
      expect(values.slice(0, 2)).toEqual(['default', 'model-a']);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not synthesize a legacy compat sentinel for configured backend targets without a runtime carrier', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).not.toHaveBeenCalled();
    expect(latest.preflightModels).toBeNull();
    expect(latest.modelOptions).toEqual([]);
    expect(latest.probe.phase).toBe('idle');
  });

  it('uses the runtime carrier agent id when probing a configured backend target', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();
    const catalog = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'review-bot', name: 'review-bot',
      title: 'Review Bot', launch: { kind: 'command', command: 'review-bot', args: [] }, createdAt: 1, updatedAt: 1 }] });
    const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
      installedPackagesById: { [CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId]: {
        id: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId, displayName: 'Configured ACP', version: '1.0.0',
        enabled: true, source: { kind: 'path', locator: '/plugins/custom-acp' } } },
      agentsById: { 'custom-acp': { id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
        title: 'Configured ACP', catalogAgentId: 'codex' } } });
    preflight.network.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/account/entity-rows/acp'
      ? Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) : preflight.respondHttp(input));
    preflight.network.setRpcResponder(async request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      ? { protocolVersion: 1, projection } : preflight.respondRpc(request));

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        runtimeCarrierAgentId: 'codex',
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    const request = capabilityRpc.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      id: 'cli.codex',
      method: 'probeModels',
      params: expect.objectContaining({
        cwd: '/repo',
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
      }),
    });
  });
});
