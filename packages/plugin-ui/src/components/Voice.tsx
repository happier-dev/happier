import type { ReactElement, ReactNode } from 'react';
import type { VoiceAttemptPresentation } from '@happier-dev/plugin-sdk/voice';
import { View } from 'react-native';

import { useHappierUiAnimationActivityInternal } from '../environment/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type VoicePresenceProps = Readonly<{
  /** Only idle Start uses this intent; active and recovery controls retain the admitted attempt. */
  target: Readonly<{ kind: 'global' }> | Readonly<{ kind: 'default' }>
    | Readonly<{ kind: 'session'; sessionAddress: Readonly<{ serverId: string; sessionId: string }> | null }>;
  /** May narrow host visibility, never reactivate a hidden surface. */
  presented?: boolean;
  children?: ReactNode;
  fallback?: ReactNode;
}>;

/** Shares one host attempt projection across live parts. Starts no media on mount. */
export function VoicePresence({ fallback, presented = true, ...input }: VoicePresenceProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const active = useHappierUiAnimationActivityInternal();
  if (!active || !presented) return <></>;
  return <>{host?.renderVoicePresence?.(input) ?? fallback}</>;
}

/** Read-only safe facts from the nearest VoicePresence. Mutations use ordinary host Actions. */
export function useVoiceAttempt(): VoiceAttemptPresentation | null {
  return useOptionalPluginUiPresentationHost()?.useVoiceAttempt?.() ?? null;
}

export type VoiceReadAloudPhase = 'idle' | 'preparing' | 'speaking';

/** The existing host playback phase; null outside a supported VoicePresence. */
export function useVoiceReadAloudPhase(): VoiceReadAloudPhase | null {
  return useOptionalPluginUiPresentationHost()?.useVoiceReadAloudPhase?.() ?? null;
}

export type VoiceMarkProps = Readonly<{ size: number; testID?: string; fallback?: ReactNode }>;
export function VoiceMark({ fallback, ...input }: VoiceMarkProps): ReactElement {
  return <>{useOptionalPluginUiPresentationHost()?.renderVoiceMark?.(input) ?? fallback}</>;
}

export type VoiceStatusLineProps = Readonly<{ size: 'pill' | 'island' | 'hero'; testID?: string; fallback?: ReactNode }>;
export function VoiceStatusLine({ fallback, ...input }: VoiceStatusLineProps): ReactElement {
  return <>{useOptionalPluginUiPresentationHost()?.renderVoiceStatusLine?.(input) ?? fallback}</>;
}

export type VoiceTransportProps = Readonly<{ size: 'pill' | 'island' | 'touch'; testID?: string; fallback?: ReactNode }>;
export function VoiceTransport({ fallback, ...input }: VoiceTransportProps): ReactElement {
  return <>{useOptionalPluginUiPresentationHost()?.renderVoiceTransport?.(input) ?? fallback}</>;
}

export type VoiceCompactTranscriptProps = Readonly<{ testID?: string; fallback?: ReactNode }>;
/** The host's compact caption and latest words from the nearest VoicePresence. */
export function VoiceCompactTranscript({ fallback, ...input }: VoiceCompactTranscriptProps): ReactElement {
  return <>{useOptionalPluginUiPresentationHost()?.renderVoiceCompactTranscript?.(input) ?? fallback}</>;
}

export type VoiceMarkArtProps = Readonly<{
  pose: 'mic' | 'ready' | 'shadow' | 'eclipse' | 'shade';
  size: number;
  theme?: 'light' | 'dark';
  light?: readonly [number, number, number];
  /** Default true. False permits pose/light event transitions, never live energy or ambient motion. */
  still?: boolean;
  testID?: string;
  fallback?: ReactNode;
}>;

/** A decorative specimen of the one Brand mark. Wrap it in a labelled control when interactive. */
export function VoiceMarkArt({ fallback, ...input }: VoiceMarkArtProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const presented = useHappierUiAnimationActivityInternal();
  return <>{host?.renderVoiceMarkArt?.({ ...input, still: presented ? input.still : true }) ?? fallback}</>;
}

export type StatusCellProps = Readonly<{
  kind: 'working' | 'thinking' | 'needs_you';
  label: string;
  size?: number;
  theme?: 'light' | 'dark';
  still?: boolean;
  testID?: string;
  fallback?: ReactNode;
}>;

/** A labelled generic work fact, not Voice state. Host motion and visibility rules still apply. */
export function StatusCell({ label, fallback, ...input }: StatusCellProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const presented = useHappierUiAnimationActivityInternal();
  return <View accessibilityRole="image" accessibilityLabel={label}>
    {host?.renderStatusCell?.({ ...input, presented }) ?? fallback}
  </View>;
}

export type DictationButtonProps = Readonly<{
  /** Receives editable text only. The author inserts it into its own field; nothing submits it. */
  onTranscription(text: string): void;
  disabled?: boolean;
  /** Optional narrowing; cannot reactivate a hidden host surface. */
  presented?: boolean;
  testID?: string;
  fallback?: ReactNode;
}>;

/** Independent host Dictation for any plugin-owned text input; no STT or conversation runtime. */
export function DictationButton({ fallback, presented = true, ...input }: DictationButtonProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const active = useHappierUiAnimationActivityInternal();
  return <>{host?.renderDictationButton?.({ ...input, presented: active && presented }) ?? fallback}</>;
}
