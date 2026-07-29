import type {
  VoiceAdapterController,
  VoiceAdapterContextChannel,
  VoiceAdapterId,
  VoiceAdapterSurfaceCapabilities,
  VoiceAdapterRuntimeActionResult,
} from './types';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
  listExternalVoiceProviderRegistrations,
  subscribeExternalVoiceProviderRegistrations,
} from '@/voice/registry/externalVoiceProviderRegistrations';

type Registry = Readonly<{
  get: (id: VoiceAdapterId) => VoiceAdapterController | null;
  list: () => ReadonlyArray<VoiceAdapterController>;
  subscribe?: (listener: () => void) => () => void;
}>;

let controllers: VoiceAdapterController[] = [];
const registryListeners = new Set<() => void>();

subscribeExternalVoiceProviderRegistrations(() => {
  for (const listener of registryListeners) listener();
});

function listControllers(): VoiceAdapterController[] {
  const byId = new Map<string, VoiceAdapterController>();
  for (const controller of controllers) byId.set(controller.id, controller);
  for (const registration of listExternalVoiceProviderRegistrations()) {
    if (registration.adapter && !byId.has(registration.providerId)) {
      byId.set(registration.providerId, registration.adapter);
    }
  }
  return [...byId.values()];
}

export function registerVoiceAdapters(next: ReadonlyArray<VoiceAdapterController>): void {
  const seen = new Set<string>();
  controllers = next.flatMap((controller) => {
    const id = normalizeNonEmptyString(controller.id);
    if (id === null || seen.has(id)) return [];
    seen.add(id);
    return [{ ...controller, id }];
  });
  for (const listener of registryListeners) listener();
}

export function getVoiceAdapterRegistry(): Registry {
  return {
    get: (id) => {
      const normalizedId = normalizeNonEmptyString(id);
      if (normalizedId === null) return null;
      return listControllers().find((c) => c.id === normalizedId) ?? null;
    },
    list: () => listControllers(),
    subscribe: (listener) => {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
  };
}

/** Sole fail-closed projection for adapter-owned surface semantics. */
export function resolveVoiceAdapterSurfaceCapabilities(
  adapterId: VoiceAdapterId,
  voiceSettings: unknown,
): VoiceAdapterSurfaceCapabilities | null {
  const adapter = getVoiceAdapterRegistry().get(adapterId);
  if (!adapter?.resolveSurfaceCapabilities) return null;
  try {
    const capability = adapter.resolveSurfaceCapabilities(voiceSettings);
    if (!capability
      || typeof capability.allowsGlobalStart !== 'boolean'
      || (capability.controlSessionScope !== 'surface' && capability.controlSessionScope !== 'global')
      || typeof capability.requiresVoiceAgentFeature !== 'boolean'
      || typeof capability.bargeInEnabled !== 'boolean'
      || (capability.agentRuntime !== undefined
        && (
          normalizeNonEmptyString(capability.agentRuntime.pluginId) === null
          || normalizeNonEmptyString(capability.agentRuntime.localId) === null
        ))
      || (capability.interruptionPolicy !== undefined
        && capability.interruptionPolicy !== 'disabled'
        && capability.interruptionPolicy !== 'client_two_stage'
        && capability.interruptionPolicy !== 'provider_immediate')) {
      return null;
    }
    return Object.freeze({
      allowsGlobalStart: capability.allowsGlobalStart,
      controlSessionScope: capability.controlSessionScope,
      requiresVoiceAgentFeature: capability.requiresVoiceAgentFeature,
      bargeInEnabled: capability.bargeInEnabled && typeof adapter.bargeIn === 'function',
      cancelResponse: capability.cancelResponse === 'immediate' ? 'immediate' : 'unsupported',
      ...(capability.interruptionPolicy !== undefined
        ? { interruptionPolicy: capability.interruptionPolicy }
        : {}),
      ...(capability.agentRuntime !== undefined
        ? {
            agentRuntime: Object.freeze({
              pluginId: capability.agentRuntime.pluginId.trim(),
              localId: capability.agentRuntime.localId.trim(),
            }),
          }
        : {}),
    });
  } catch {
    return null;
  }
}

/** Sole fail-closed projection for adapter-owned context delivery semantics. */
export function resolveVoiceAdapterContextChannel(
  adapterId: VoiceAdapterId,
  voiceSettings: unknown,
): VoiceAdapterContextChannel | null {
  const adapter = getVoiceAdapterRegistry().get(adapterId);
  if (!adapter?.resolveContextChannel) return null;
  try {
    const channel = adapter.resolveContextChannel(voiceSettings);
    if (!channel
      || typeof channel.sendContextualUpdate !== 'function'
      || typeof channel.sendTextMessage !== 'function'
      || (channel.announceAssistantText !== undefined && typeof channel.announceAssistantText !== 'function')) {
      return null;
    }
    return Object.freeze({
      sendContextualUpdate: channel.sendContextualUpdate,
      sendTextMessage: channel.sendTextMessage,
      ...(channel.announceAssistantText ? { announceAssistantText: channel.announceAssistantText } : {}),
    });
  } catch {
    return null;
  }
}

/** Provider-neutral action dispatch. Unknown adapters/actions fail closed. */
export async function performVoiceAdapterRuntimeAction(
  adapterId: VoiceAdapterId,
  actionId: string,
): Promise<VoiceAdapterRuntimeActionResult> {
  const adapter = getVoiceAdapterRegistry().get(adapterId);
  const normalizedActionId = normalizeNonEmptyString(actionId);
  if (!adapter?.performRuntimeAction || normalizedActionId === null) return { status: 'unsupported' };
  try {
    const result = await adapter.performRuntimeAction(normalizedActionId);
    if (result?.status === 'completed' || result?.status === 'unsupported') return result;
    if (result?.status === 'failed' && normalizeNonEmptyString(result.code)) return result;
    return { status: 'failed', code: 'voice_runtime_action_invalid_result' };
  } catch {
    return { status: 'failed', code: 'voice_runtime_action_failed' };
  }
}

export function resetVoiceAdapterRegistryForTests(): void {
  controllers = [];
}
