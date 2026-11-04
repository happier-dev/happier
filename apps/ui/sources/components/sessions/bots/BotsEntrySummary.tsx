import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useBotsSummary } from './botsSummary';
import { SessionBotFace } from './face/SessionBotFace';

const FACE_SIZE_PX = 20;

/**
 * What the phone's one Bots entry says before the roster opens (lab `b-rail Ap`): a few faces, then what
 * needs you. It reads only the closed-entry summary; the roster mounts when it opens. Nothing to say
 * renders nothing, so the entry stays a plain navigation row.
 */
export const BotsEntrySummary = React.memo(function BotsEntrySummary() {
  const { theme } = useUnistyles();
  const summary = useBotsSummary();
  if (summary.faces.length === 0 && summary.needsYou === 0) return null;
  return (
    <View testID="bots-entry-summary" style={styles.detail}>
      {summary.faces.length > 0 ? (
        <AvatarStack
          size={FACE_SIZE_PX}
          entries={summary.faces.map((face) => ({
            key: face.key,
            content: <SessionBotFace facts={face.face} size={FACE_SIZE_PX} mood={face.activity} motion />,
          }))}
        />
      ) : null}
      {summary.needsYou > 0 ? (
        <View style={styles.summary}>
          <StatusDot color={theme.colors.state.warning.foreground} />
          <Text
            testID="bots-entry-summary.needs-you"
            style={styles.summaryText}
            numberOfLines={1}
          >
            {t('bots.roster.needsYou', { count: summary.needsYou })}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  detail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexShrink: 1,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flexShrink: 1,
  },
  summaryText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
