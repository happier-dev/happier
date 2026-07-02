import type { AgentMessage } from '@/agent/core';

import {
  publishPiRuntimeState,
  publishPiUsageStatsBestEffort,
  resolvePiModelSelection,
} from './runtimeState';
import type {
  PiRpcCommandsData,
  PiRpcModelsData,
  PiRpcSessionStatsData,
  PiRpcStateData,
} from './types';

export class PiRuntimeStateTracker {
  private currentModelProvider: string | null = null;
  private readonly modelProviderById = new Map<string, string>();
  private sessionModelState: {
    currentModelId: string;
    availableModels: Array<{ id: string; name: string; description?: string }>;
  } | null = null;
  private lastPublishedUsageKey: string | null = null;

  getSessionModelState(): { currentModelId: string; availableModels: Array<{ id: string; name: string; description?: string }> } | null {
    return this.sessionModelState;
  }

  getCurrentModelProvider(): string | null {
    return this.currentModelProvider;
  }

  rememberCurrentModelProvider(provider: string): void {
    this.currentModelProvider = provider;
  }

  async publishUsageStatsBestEffort(params: Readonly<{
    disposed: boolean;
    hasProcess: boolean;
    getSessionStats: () => Promise<PiRpcSessionStatsData>;
    emitMessage: (message: AgentMessage) => void;
  }>): Promise<void> {
    this.lastPublishedUsageKey = await publishPiUsageStatsBestEffort({
      disposed: params.disposed,
      hasProcess: params.hasProcess,
      lastPublishedUsageKey: this.lastPublishedUsageKey,
      getSessionStats: params.getSessionStats,
      emitMessage: params.emitMessage,
    });
  }

  async publishRuntimeState(params: Readonly<{
    state: PiRpcStateData;
    getAvailableModels: () => Promise<PiRpcModelsData>;
    getCommands: () => Promise<PiRpcCommandsData>;
    emitMessage: (message: AgentMessage) => void;
  }>): Promise<void> {
    const publishedState = await publishPiRuntimeState({
      state: params.state,
      currentModelProvider: this.currentModelProvider,
      previousSessionModelState: this.sessionModelState,
      modelProviderById: this.modelProviderById,
      getAvailableModels: params.getAvailableModels,
      getCommands: params.getCommands,
      emitMessage: params.emitMessage,
    });
    this.currentModelProvider = publishedState.currentModelProvider;
    this.sessionModelState = publishedState.sessionModelState;
  }

  async resolveModelSelection(params: Readonly<{
    modelIdRaw: string;
    getState: () => Promise<PiRpcStateData>;
  }>): Promise<{ provider: string; modelId: string }> {
    const selection = await resolvePiModelSelection({
      modelIdRaw: params.modelIdRaw,
      modelProviderById: this.modelProviderById,
      currentModelProvider: this.currentModelProvider,
      getState: params.getState,
    });
    this.currentModelProvider = selection.currentModelProvider;
    return {
      provider: selection.provider,
      modelId: selection.modelId,
    };
  }
}
