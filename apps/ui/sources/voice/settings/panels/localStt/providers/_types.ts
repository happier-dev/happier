import type * as React from 'react';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';

export type LocalSttProviderId = VoiceLocalSttSettings['provider'];

export type LocalSttProviderSettingsProps = {
  cfgStt: VoiceLocalSttSettings | any;
  setStt: (next: VoiceLocalSttSettings | any) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
};

export type LocalSttProviderSpec = {
  id: LocalSttProviderId;
  title: string;
  subtitle: string;
  iconName: string;
  detail: string;
  Settings: React.ComponentType<LocalSttProviderSettingsProps>;
};

