import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readAcpSessionModeIntentFromMetadata } from '@happier-dev/agents';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { AgentSessionModelsSnapshot, AgentSessionModesSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../../../packages/plugins/opencode/src/agent/providerBinding/adapter';
import { createOpenCodeServerRuntimeAssembly } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly';
import { createContextFixture } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.managedServices.testkit';
import { OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL } from '../../../../../../../packages/plugins/opencode/src/agent/auth/services/requestAuth/source';

describe('createNativeAgentSessionPublications', () => {
  it.each(['provider', 'native-chatgpt'] as const)('withholds prior global choices when the real OpenCode %s runtime has no Account model observation', async (source) => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-catalog-'));
    const connectionId = ProviderConnectionIdSchema.parse('pc_catalog_account');
    const model = { id: 'openai/selected-model', name: 'Selected model' };
    const agentTargetKey = 'agent:happier.agent.opencode/opencode';
    const prepared = OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare({ v: 1, connectionId, agentTargetKey });
    const output = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({ v: 1, prepared,
      binding: { v: 1, agentTargetKey, selection: { connectionId, model }, contributionKey: 'example.provider/chat',
        endpoint: { endpointTemplateId: 'chat', protocol: 'openai-chat', normalizedUrl: 'http://127.0.0.1:49199/v1', publicHeaders: {} },
        runtimeCredentialTransport: null, compatibilityFingerprint: 'pcf1:catalog-fixture' },
      credential: { kind: 'none' },
    });
    if (output.kind !== 'configFile') throw new Error('Expected canonical OpenCode private configuration');
    for (const file of output.files) {
      const path = join(rootPath, file.relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.utf8);
    }
    let metadata = createTestMetadata({ path: '/repo', sessionModelsV1: {
      v: 1, agentId: 'opencode', currentModelId: model.id, updatedAt: 1,
      availableModels: [{ id: 'ambient/global-model', name: 'Global model' }],
    } });
    const publications = createNativeAgentSessionPublications({ agentId: 'opencode', session: null,
      signal: new AbortController().signal, isCurrent: () => true, supportsInFlightSteer: false });
    const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49199',
      managedServerRequest: async input => {
        const path = input.pathAndQuery.split('?')[0];
        const body = path === '/provider'
          ? { all: [{ id: 'openai', options: { baseURL: OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL },
            models: { 'selected-model': { id: 'selected-model', name: 'Selected model' } } }], connected: ['openai'] }
          : path === '/session' ? { id: 'catalog-native-session' } : {};
        return { ok: true, status: 200, headers: { 'content-type': 'application/json' },
          body: new Response(JSON.stringify(body)).body };
      },
    });
    let assembly: Awaited<ReturnType<typeof createOpenCodeServerRuntimeAssembly>> | undefined;
    let publisher: ReturnType<typeof createSessionRuntimeModelsPublisher> | undefined;
    try {
      assembly = await createOpenCodeServerRuntimeAssembly({ ctx, directory: '/repo', happierSessionId: 'catalog-session',
        endpoint: { mode: 'managed-spawn' }, models: publications.services.models,
        request: { kind: 'create', cwd: '/repo', sessionId: 'catalog-session',
          configuration: { model: { value: model.id, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
          ...(source === 'provider' ? { providerBinding: { connectionId, model,
            materialization: { v: 1 as const, kind: 'configFile' as const, rootPath, relativePaths: output.files.map(file => file.relativePath) } } } : {}),
        },
      });
      publisher = createSessionRuntimeModelsPublisher({ agentId: 'opencode', source: publications.modelsSource,
        session: { getMetadataSnapshot: () => metadata,
          updateMetadataAsCurrentPublisher: updater => { metadata = updater(metadata); }, on() {}, off() {} },
      });
      await publisher.flush();
      expect(metadata.sessionModelsV1).toMatchObject({ currentModelId: model.id, availableModels: [] });
    } finally {
      await publisher?.stopAndDrain();
      await assembly?.dispose();
      publications.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each(['plan', 'build'] as const)('completes an accepted native mode only when the saved selection still matches (%s)', async (selectedMode) => {
    let metadata: Metadata = createTestMetadata({
      path: '/tmp/workspace',
      sessionModeOverrideV1: { v: 1, modeId: selectedMode, updatedAt: 10 },
      acpSessionModeOverrideV1: { v: 1, modeId: selectedMode, updatedAt: 10 },
    });
    const publications = createNativeAgentSessionPublications({
      agentId: 'claude', signal: new AbortController().signal,
      isCurrent: () => true, supportsInFlightSteer: false,
      session: {
        updateAgentState: vi.fn(),
        updateMetadataAsCurrentPublisher: async (updater: (current: Metadata) => Metadata) => {
          metadata = updater(metadata);
        },
      },
    });
    await publications.services.modes.complete!({ modeId: 'plan' });
    expect(readAcpSessionModeIntentFromMetadata(metadata)?.modeId).toBe(selectedMode === 'plan' ? null : 'build');
    if (selectedMode === 'plan') {
      expect(metadata.acpSessionModeOverrideV1?.modeId).toBeNull();
      expect(metadata.sessionModeOverrideV1?.updatedAt).toBeGreaterThan(10);
    }
    publications.dispose();
  });

  it('refuses mode completion if the runtime retires before the publisher applies it', async () => {
    let current = true;
    let metadata: Metadata = createTestMetadata({ path: '/tmp/workspace',
      sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 10 } });
    const publications = createNativeAgentSessionPublications({
      agentId: 'claude', signal: new AbortController().signal,
      isCurrent: () => current, supportsInFlightSteer: false,
      session: { updateAgentState: vi.fn(),
        updateMetadataAsCurrentPublisher: async (updater: (value: Metadata) => Metadata) => {
          current = false;
          metadata = updater(metadata);
        },
      },
    });
    await expect(publications.services.modes.complete!({ modeId: 'plan' })).rejects.toThrow('retired or unavailable');
    expect(readAcpSessionModeIntentFromMetadata(metadata)?.modeId).toBe('plan');
    publications.dispose();
  });

  it('admits one native modes source and fences late observations after unbind or retirement', () => {
    let current = true;
    const abort = new AbortController();
    const updateAgentState = vi.fn();
    const publications = createNativeAgentSessionPublications({ agentId: 'opencode', session: { updateAgentState }, signal: abort.signal, isCurrent: () => current, supportsInFlightSteer: false });
    const listeners = new Set<(snapshot: AgentSessionModesSnapshot) => void>();
    const initial = { modes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }], currentModeId: 'build', observedAt: 1 };
    const source = { read: () => initial, subscribe(listener: (snapshot: AgentSessionModesSnapshot) => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } };
    const binding = publications.services.modes.bind(source);
    expect(publications.modesSource.read()).toEqual(initial);
    expect(() => publications.services.modes.bind(source)).toThrow();
    const staleListener = [...listeners][0]!;
    binding.dispose();
    expect(publications.modesSource.read()).toEqual({ modes: null });
    const successor = publications.services.modes.bind(source);
    staleListener({ modes: [], currentModeId: 'plan', observedAt: 2 });
    expect(publications.modesSource.read()).toEqual(initial);
    current = false;
    for (const listener of listeners) listener({ modes: [], currentModeId: 'plan', observedAt: 3 });
    expect(publications.modesSource.read()).toEqual(initial);
    expect(() => publications.services.modes.bind(source)).toThrow();
    abort.abort();
    expect(listeners.size).toBe(0);
    successor.dispose();
    publications.dispose();
    expect(updateAgentState).not.toHaveBeenCalled();
  });
  it('withholds unverified account choices while retaining the active model and observed catalogs', () => {
    const publications = createNativeAgentSessionPublications({
      agentId: 'pi', session: null, signal: new AbortController().signal,
      isCurrent: () => true, supportsInFlightSteer: false,
    });
    let snapshot: AgentSessionModelsSnapshot = {
      observedAt: 0, currentModelId: 'selected',
      models: [{ id: 'selected', name: 'Selected' }],
    };
    let publish: ((value: AgentSessionModelsSnapshot) => void) | undefined;
    const binding = publications.services.models.bind({
      read: () => snapshot,
      subscribe(listener) { publish = listener; return { dispose() {} }; },
    });
    expect(publications.modelsSource.read().models).toEqual(snapshot.models);
    snapshot = { ...snapshot, catalogConfidence: 'account_unverified' };
    publish!(snapshot);
    expect(publications.modelsSource.read()).toMatchObject({ currentModelId: 'selected', models: [] });
    snapshot = { ...snapshot, catalogConfidence: 'probe' };
    publish!(snapshot);
    expect(publications.modelsSource.read()).toMatchObject({ currentModelId: 'selected', models: snapshot.models });
    binding.dispose();
    publications.dispose();
  });

  it('adapts native model evidence without installing a competing metadata writer', async () => {
    const updateMetadata = vi.fn();
    const onMetadata = vi.fn();
    const offMetadata = vi.fn();
    const updateAgentState = vi.fn();
    const abortController = new AbortController();
    const session = {
      getMetadataSnapshot: () => null,
      updateMetadata,
      on: onMetadata,
      off: offMetadata,
      updateAgentState,
    };
    const publications = createNativeAgentSessionPublications({
      agentId: 'qwen',
      session,
      signal: abortController.signal,
      isCurrent: () => true,
      supportsInFlightSteer: false,
    });
    const sourceSnapshots: unknown[] = [];
    const unsubscribeSource = publications.modelsSource.subscribe((snapshot) => {
      sourceSnapshots.push(snapshot);
    });
    const disposeNativeSource = vi.fn();
    const binding = publications.services.models.bind({
      read: () => ({
        currentModelId: 'native-current',
        models: [
          {
            id: 'native-current',
            name: 'Native current',
          },
        ],
      }),
      subscribe: () => ({
        dispose: disposeNativeSource,
      }),
    });

    expect(publications.modelsSource.read()).toMatchObject({
      currentModelId: 'native-current',
      models: [
        {
          id: 'native-current',
          name: 'Native current',
        },
      ],
    });
    expect(sourceSnapshots).toHaveLength(2);
    await Promise.resolve();
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(onMetadata).not.toHaveBeenCalled();

    unsubscribeSource.dispose();
    binding.dispose();
    publications.dispose();
    expect(disposeNativeSource).toHaveBeenCalledOnce();
    expect(offMetadata).not.toHaveBeenCalled();
  });

  it.each([false, true])('replays native model evidence without restoring an unverified static catalog (unverified=%s)', async (unverified) => {
    let metadata: Metadata = {
      path: '/tmp/workspace',
      host: 'test-host',
      homeDir: '/tmp/home',
      happyHomeDir: '/tmp/home/.happier',
      happyLibDir: '/tmp/home/.happier/lib',
      happyToolsDir: '/tmp/home/.happier/tools',
      sessionModelsV1: { v: 1, agentId: 'qwen', updatedAt: 10, currentModelId: 'old',
        availableModels: [{ id: 'old', name: 'Previously available' }] },
    };
    const metadataListeners = new Set<() => void>();
    const updateMetadata = vi.fn(async (updater: (current: Metadata) => Metadata) => {
      metadata = updater(metadata);
      for (const listener of metadataListeners) listener();
    });
    const onMetadata = vi.fn((_event: 'metadata-updated', listener: () => void) => {
      metadataListeners.add(listener);
    });
    const offMetadata = vi.fn((_event: 'metadata-updated', listener: () => void) => {
      metadataListeners.delete(listener);
    });
    const session = {
      getMetadataSnapshot: () => metadata,
      updateMetadata,
      updateMetadataAsCurrentPublisher: updateMetadata,
      on: onMetadata,
      off: offMetadata,
      updateAgentState: vi.fn(),
    };
    const publications = createNativeAgentSessionPublications({
      agentId: 'qwen',
      session,
      signal: new AbortController().signal,
      isCurrent: () => true,
      supportsInFlightSteer: false,
    });
    const projector = createSessionRuntimeModelsPublisher({
      agentId: 'qwen',
      session,
      source: publications.modelsSource,
    });
    const disposeNativeSource = vi.fn();
    const binding = publications.services.models.bind({
      read: () => ({
        ...(unverified ? { catalogConfidence: 'account_unverified' as const, observedAt: 0 } : {}),
        currentModelId: 'native-current',
        models: [
          {
            id: 'native-current',
            name: 'Native current',
          },
        ],
      }),
      subscribe: () => ({
        dispose: disposeNativeSource,
      }),
    });

    await projector.flush();
    expect(metadata.sessionModelsV1).toMatchObject({
      agentId: 'qwen',
      currentModelId: 'native-current',
      availableModels: unverified ? [] : [{ id: 'native-current', name: 'Native current' }],
    });
    expect(updateMetadata).toHaveBeenCalled();
    expect(onMetadata).toHaveBeenCalledOnce();

    projector.dispose();
    binding.dispose();
    publications.dispose();
    expect(offMetadata).toHaveBeenCalledOnce();
    expect(disposeNativeSource).toHaveBeenCalledOnce();
  });
});
