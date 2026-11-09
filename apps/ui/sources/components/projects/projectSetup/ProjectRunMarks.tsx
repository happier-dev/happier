import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';

import {
  formatRunClock,
  type ProjectRunGlyph,
} from './projectScriptPresentation';

/** A finite run's status mark: the one glyph every Scripts row, Machine work row and tool line shows. */
export function RunGlyph(props: Readonly<{
  glyph: ProjectRunGlyph;
  /** A widget glance row's mark column draws every state at its one small step. */
  size?: number;
}>) {
  const { theme } = useUnistyles();
  if (props.glyph === 'running')
    return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;
  const name =
    props.glyph === 'succeeded'
      ? 'check-circle'
      : props.glyph === 'failed'
        ? 'x-circle'
        : props.glyph === 'queued'
          ? 'hourglass'
          : props.glyph === 'attention'
            ? 'warning-circle'
            : props.glyph === 'stopped'
              ? 'stop-circle'
              : 'circle';
  const color =
    props.glyph === 'failed'
      ? theme.colors.status.error
      : props.glyph === 'attention'
        ? theme.colors.state.attention.foreground
        : props.glyph === 'idle'
          ? theme.colors.text.tertiary
          : theme.colors.text.secondary;
  // Not run yet is a quiet ring, never mistaken for a checkbox (lab: a small tertiary ring).
  return <Icon name={name} size={props.size ?? (props.glyph === 'idle' ? 16 : 18)} color={color} />;

}

/** A live run's elapsed clock ("1:42"), in its own leaf so only it re-renders every second. */
export function RunClock(props: Readonly<{ startedAt: number }>) {
  const { theme } = useUnistyles();
  const seconds = useElapsedTime(props.startedAt);
  return (
    <Text style={[styles.clock, { color: theme.colors.text.tertiary }]}>
      {formatRunClock(seconds)}
    </Text>
  );
}

const styles = StyleSheet.create(() => ({
  clock: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    fontVariant: ['tabular-nums'],
  },
}));
