import type * as React from 'react';

import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';

export type LocalTtsProviderId = VoiceLocalTtsSettings['provider'];

export type LocalTtsProviderSettingsProps = {
  cfgTts: VoiceLocalTtsSettings;
  setTts: (next: VoiceLocalTtsSettings) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
};

export type LocalTtsProviderTestContext = {
  cfgTts: VoiceLocalTtsSettings;
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

