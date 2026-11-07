import * as React from 'react';
import type { ReactElement } from 'react';
import {
  Text,
  useSurfaceContext,
  type TextTone,
  type TextVariant,
} from '@happier-dev/plugin-ui';
import type { ForgeCiStateV1 } from '@happier-dev/triage-protocol/ci/v1';
import { useForgeCiNowMsV1 } from './clock.js';
import { formatForgeCiDurationV1, readForgeCiElapsedMsV1 } from './format.js';

export type ForgeCiElapsedTextProps = Readonly<{
  item: Readonly<{
    startedAtMs?: number | undefined;
    completedAtMs?: number | undefined;
    updatedAtMs?: number | undefined;
    state: ForgeCiStateV1;
  }>;
  variant?: TextVariant;
  tone?: TextTone;
  /** Shown when no honest duration exists (queued, unknown start); absent renders nothing. */
  fallback?: string;
  testID?: string;
}>;

/**
 * A run's, job's or step's duration as the one live leaf. Only a running item ticks, once a second while the
 * surface is visible, and only this leaf re-renders: the rows, groups and models around it keep their identity.
 */
export function ForgeCiElapsedText({
  item,
  variant = 'meta',
  tone = 'secondary',
  fallback,
  testID,
}: ForgeCiElapsedTextProps): ReactElement | null {
  const { locale } = useSurfaceContext();
  const nowMs = useForgeCiNowMsV1(item.state.phase === 'running');
  const elapsed = readForgeCiElapsedMsV1(item, nowMs);
  const value =
    elapsed === null ? fallback : formatForgeCiDurationV1(elapsed, locale);
  if (value === undefined) return null;
  return (
    <Text
      variant={variant}
      tone={tone}
      value={value}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}
