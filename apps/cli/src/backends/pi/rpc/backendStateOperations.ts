import type { PiRuntimeStateTracker } from './piRuntimeStateTracker';
import { asRecord } from './rpcSupport';
import type { PiRpcCommandWithoutId, PiRpcCommandsData, PiRpcModelsData, PiRpcResponse, PiRpcSessionStatsData, PiRpcStateData } from './types';

export function createPiRpcStateOperations(params: Readonly<{
  sendCommand: (command: PiRpcCommandWithoutId, timeoutMs?: number) => Promise<PiRpcResponse>;
  runtimeState: PiRuntimeStateTracker;
  emitMessage: (message: import('@/agent/core').AgentMessage) => void;
  isDisposed: () => boolean;
  hasProcess: () => boolean;
}>): Readonly<{
  getState: (timeoutMs?: number) => Promise<PiRpcStateData>;
  getAvailableModels: () => Promise<PiRpcModelsData>;
  getSessionStats: () => Promise<PiRpcSessionStatsData>;
  getCommands: () => Promise<PiRpcCommandsData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
  resolveModelSelection: (modelIdRaw: string) => Promise<{ provider: string; modelId: string }>;
  publishUsageStatsBestEffort: () => Promise<void>;
}> {
  const getState = async (timeoutMs = 30_000): Promise<PiRpcStateData> => {
    const response = await params.sendCommand({ type: 'get_state' }, timeoutMs);
    return (asRecord(response.data) ?? {}) as PiRpcStateData;
  };

  const getAvailableModels = async (): Promise<PiRpcModelsData> => {
    const response = await params.sendCommand({ type: 'get_available_models' }, 60_000);
    return (asRecord(response.data) ?? {}) as PiRpcModelsData;
  };

  const getSessionStats = async (): Promise<PiRpcSessionStatsData> => {
    const response = await params.sendCommand({ type: 'get_session_stats' }, 30_000);
    return (asRecord(response.data) ?? {}) as PiRpcSessionStatsData;
  };

  const getCommands = async (): Promise<PiRpcCommandsData> => {
    const response = await params.sendCommand({ type: 'get_commands' }, 30_000);
    return (asRecord(response.data) ?? {}) as PiRpcCommandsData;
  };

  const publishRuntimeState = async (state: PiRpcStateData): Promise<void> => {
    await params.runtimeState.publishRuntimeState({
      state,
      getAvailableModels,
      getCommands,
      emitMessage: params.emitMessage,
    });
  };

  const resolveModelSelection = async (modelIdRaw: string): Promise<{ provider: string; modelId: string }> => {
    return await params.runtimeState.resolveModelSelection({
      modelIdRaw,
      getState,
    });
  };

  const publishUsageStatsBestEffort = async (): Promise<void> => {
    await params.runtimeState.publishUsageStatsBestEffort({
      disposed: params.isDisposed(),
      hasProcess: params.hasProcess(),
      getSessionStats,
      emitMessage: params.emitMessage,
    });
  };

  return {
    getState,
    getAvailableModels,
    getSessionStats,
    getCommands,
    publishRuntimeState,
    resolveModelSelection,
    publishUsageStatsBestEffort,
  };
}
