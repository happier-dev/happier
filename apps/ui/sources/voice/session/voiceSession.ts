import * as React from 'react';
import { createVoiceSessionManager } from './voiceSessionManager';
import { getVoiceSessionLifecycleController, requestVoiceSessionRuntime } from './voiceSessionLifecycleControllerStore';
import { beginVoiceSessionRuntimePreparation, getVoiceSessionSnapshot, getVoiceSessionRestartTarget, subscribeToVoiceSessionSnapshot } from './voiceSessionStore';
import type { VoiceSessionSnapshot } from './types';
import { storage } from '@/sync/domains/state/storage';
import { resolveStoredVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';

export const voiceSessionManager = createVoiceSessionManager({
  getLifecycleController: () => getVoiceSessionLifecycleController(),
  getRuntimeRetryTarget: () => {
    const state = storage.getState();
    const providerId = resolveStoredVoiceProviderId(state.settings.voiceSettingsV1.providerId);
    const target = providerId ? getVoiceSessionRestartTarget(providerId, state.profileScope) : null;
    return target?.kind === 'session' ? target.sessionAddress : null;
  },
  requestRuntime: (target, signal) => {
    const providerId = resolveStoredVoiceProviderId(storage.getState().settings.voiceSettingsV1.providerId);
    if (!providerId) return null;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const snapshot: VoiceSessionSnapshot = { adapterId: providerId,
      sessionId: target?.sessionId ?? VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connecting', mode: 'idle', canStop: true };
    const preparation = beginVoiceSessionRuntimePreparation(snapshot, lifetime ? {
      accountScope: lifetime.scope, targetSessionAddress: target, conversationScope: null,
    } : null);
    const request = requestVoiceSessionRuntime(providerId, signal);
    const cancelPreparation = () => preparation.dispose();
    signal.addEventListener('abort', cancelPreparation, { once: true });
    const retirement = lifetime?.onRetire(() => {
      request.dispose();
      preparation.dispose();
    });
    let disposed = false;
    return {
      ready: request.ready.then((controller) => {
        if (signal.aborted || (lifetime && !lifetime.isCurrent())) return null;
        // The clicked provider is admitted once, even before React has committed a selection edit.
        controller?.setConfiguredProviderId(providerId);
        return controller;
      }),
      adopt: preparation.adopt,
      dispose: (error) => {
        if (disposed) return;
        disposed = true;
        signal.removeEventListener('abort', cancelPreparation);
        request.dispose();
        retirement?.dispose();
        const failure = error ? createVoiceMachineError({ kind: 'service_temporarily_unavailable', reason: 'voice_provider_adapter_not_registered' }) : null;
        preparation.dispose(failure ? { ...snapshot, status: 'error', canStop: false,
          errorCode: failure.kind, errorMessage: failure.reason,
          errorRecoveryAction: failure.recoveryAction, errorPresentation: failure.presentation } : undefined);
        if (!lifetime || lifetime.isCurrent()) {
          getVoiceSessionLifecycleController()?.setConfiguredProviderId(
            resolveStoredVoiceProviderId(storage.getState().settings.voiceSettingsV1.providerId));
        }
      },
    };
  },
});

export function useVoiceSessionSnapshot(): VoiceSessionSnapshot {
  return React.useSyncExternalStore(
    subscribeToVoiceSessionSnapshot,
    getVoiceSessionSnapshot,
    getVoiceSessionSnapshot,
  );
}
