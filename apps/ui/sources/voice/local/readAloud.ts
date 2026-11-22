import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { localVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { storage } from '@/sync/domains/state/storage';
import { getCachedServerFeaturesSnapshot, subscribeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import { cancelLocalVoiceRecording } from './localVoiceEngine';

import { isReadAloudAvailable, resolveLocalVoiceAdapterSettings, type LocalVoiceSettingsInput } from './localVoiceSettings';
import {
  finishReadAloudRun,
  getReadAloudActiveKey,
  isReadAloudRunCurrent,
  startReadAloudRun,
  stopReadAloud,
  trackReadAloudStopper,
} from './readAloudState';

type ReadAloudSettings = LocalVoiceSettingsInput & FeatureLocalPolicySettings;

function canReadAloud(settings: ReadAloudSettings): boolean {
  return isReadAloudAvailable(settings) && resolveRuntimeFeatureDecisionFromSnapshot({
    featureId: 'voice',
    settings,
    snapshot: getCachedServerFeaturesSnapshot() ?? { status: 'loading' },
    scope: { scopeKind: 'runtime' },
  })?.state === 'enabled';
}

/**
 * Reads one transcript message aloud with the configured local TTS provider, or stops it when it
 * is already the one playing. Starting one stops whatever else is speaking (another message or a
 * live voice reply). Resolves `false` only when the provider failed.
 */
export async function toggleReadAloud(params: Readonly<{
  key: string;
  text: string;
  settings: ReadAloudSettings;
}>): Promise<boolean> {
  if (getReadAloudActiveKey() === params.key) {
    stopReadAloud();
    return true;
  }
  if (!canReadAloud(params.settings)) return true;

  localVoicePlaybackController.interrupt();
  const run = startReadAloudRun(params.key);
  // The playback owner observes revocation even when no transcript row is mounted.
  const stopIfUnavailable = () => {
    if (!canReadAloud(storage.getState().settings)) stopReadAloud();
  };
  const subscriptions = [
    storage.subscribe((state, previous) => {
      if (state.settings !== previous.settings) stopIfUnavailable();
    }),
    subscribeServerFeaturesSnapshot(stopIfUnavailable),
    subscribeActiveServer(stopIfUnavailable),
  ];
  const releaseSubscriptions = () => {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    unregisterRun();
    untrackRun();
  };
  const stopRun = () => {
    releaseSubscriptions();
    finishReadAloudRun(run);
  };
  const unregisterRun = localVoicePlaybackController.registerStopper(stopRun);
  const untrackRun = trackReadAloudStopper(stopRun);
  try {
    let settings = params.settings;
    const cancellingInput = cancelLocalVoiceRecording();
    if (cancellingInput) {
      await cancellingInput;
      if (!isReadAloudRunCurrent(run)) return true;
      settings = storage.getState().settings;
      if (!canReadAloud(settings)) return true;
    }
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    return await speakAssistantText({
      text: params.text,
      settings,
      networkTimeoutMs: resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000),
      // Registered with the shared controller (a live barge-in stops read-aloud) and tracked here
      // (a live reply can stop read-aloud without counting as a barge-in).
      registerPlaybackStopper: (stopper) => {
        const stop = () => {
          unregisterShared();
          untrack();
          stopper();
        };
        const unregisterShared = localVoicePlaybackController.registerStopper(stop);
        const untrack = trackReadAloudStopper(stop);
        return () => {
          unregisterShared();
          untrack();
        };
      },
      onSpeaking: () => {},
      takeOverReadAloud: false,
    });
  } catch (error) {
    console.warn('[voice/readAloud] microphone cancellation failed', error instanceof Error ? error.message : error);
    return false;
  } finally {
    releaseSubscriptions();
    finishReadAloudRun(run);
  }
}
