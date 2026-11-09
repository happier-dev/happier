import { describe, expect, it, vi } from 'vitest';

import { readAcpSessionModeIntentFromMetadata } from '@happier-dev/agents';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { AgentSessionModelsSnapshot, AgentSessionModesSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';

describe('createNativeAgentSessionPublications', () => {
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
