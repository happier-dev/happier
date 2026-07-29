import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';

describe('createNativeAgentSessionPublications', () => {
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

  it('replays native model evidence through one host metadata projector', async () => {
    let metadata: Metadata = {
      path: '/tmp/workspace',
      host: 'test-host',
      homeDir: '/tmp/home',
      happyHomeDir: '/tmp/home/.happier',
      happyLibDir: '/tmp/home/.happier/lib',
      happyToolsDir: '/tmp/home/.happier/tools',
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
      availableModels: [
        {
          id: 'native-current',
          name: 'Native current',
        },
      ],
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
