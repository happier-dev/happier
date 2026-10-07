import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import { useHappierUiAnimationActivityInternal } from '../environment/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

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
