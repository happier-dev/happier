import type * as React from 'react';

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
  showProcessingDisclosure?: boolean;
};
export type LocalSttProviderSpec = {
  id: LocalSttProviderId;
  title: string;
  subtitle: string;
  iconName: string;
  detail: string;
  Settings: React.ComponentType<LocalSttProviderSettingsProps>;
};
