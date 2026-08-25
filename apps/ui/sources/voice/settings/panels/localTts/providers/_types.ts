import type * as React from 'react';

import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';

export type LocalTtsProviderId = VoiceLocalTtsSettings['provider'];

export type LocalTtsProviderSettingsProps = {
  cfgTts: VoiceLocalTtsSettings;
  setTts: (next: VoiceLocalTtsSettings) => void;
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
};
export type LocalTtsProviderTestContext = {
  cfgTts: VoiceLocalTtsSettings;
  voice: VoiceSettings;
  networkTimeoutMs: number;
  sample: string;
};

export type LocalTtsProviderSpec = {
  id: LocalTtsProviderId;
  title: string;
  subtitle: string;
  iconName: string;
  detail: string;
  Settings: React.ComponentType<LocalTtsProviderSettingsProps>;
  test: (ctx: LocalTtsProviderTestContext) => Promise<void>;
};
