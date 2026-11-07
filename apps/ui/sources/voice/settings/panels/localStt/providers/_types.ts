import type * as React from 'react';
import type { LocalNeuralExecution } from '@happier-dev/protocol/daemon/voiceInference';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';

export type LocalSttProviderId = VoiceLocalSttSettings['provider'];

export type LocalSttProviderSettingsProps = {
  cfgStt: VoiceLocalSttSettings | any;
  setStt: (next: VoiceLocalSttSettings | any) => void;
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
  /** Dictation supplies its own recognition-language control and runtime override. */
  hideLanguage?: boolean;
};
export type LocalSttProviderSpec = {
  id: LocalSttProviderId;
  title: string;
  subtitle: string;
  iconName: string;
  detail: string;
  /** The engine's own options; absent when the engine has none, so no empty options section renders. */
  Settings?: React.ComponentType<LocalSttProviderSettingsProps>;
  resolvePreferredExecution?: (requestedExecution: LocalNeuralExecution | null) => 'device' | 'daemon';
};
