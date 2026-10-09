import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The one quiet line above a shared dashboard's widgets (12s3, `projects.dashboard.identity`): whose
 * it is and what this viewer can do with it, from the admitted Artifact's owner and current access.
 * It never shows on a personal, unshared dashboard: healthy is quiet. No header chip.
 */
export const ProjectDashboardIdentityLine = React.memo(
  function ProjectDashboardIdentityLine(
    props: Readonly<{
      owner: Readonly<{ accountId: string; imageUrl?: string | null }>;
      /** "Leeroy Brun’s dashboard", or "Release" for the owner's own shared dashboard. */
      title: string;
      /** The viewer's access ("Can read") or the owner's sharing summary. */
      detail: string;
      action?: Readonly<{ label: string; onPress: () => void }>;
      testID?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'project-dashboard-identity';
    return (
      <View testID={testID} style={styles.line} accessibilityRole="text">
        <Avatar
          id={props.owner.accountId}
          size={18}
          imageUrl={props.owner.imageUrl ?? null}
        />
        <Text
          numberOfLines={1}
          style={[
            styles.text,
            styles.title,
            { color: theme.colors.text.primary },
          ]}
        >
          {props.title}
        </Text>
        <Text style={[styles.text, { color: theme.colors.text.tertiary }]}>
          ·
        </Text>
        <Text
          numberOfLines={1}
          style={[
            styles.text,
            styles.detail,
            { color: theme.colors.text.secondary },
          ]}
        >
          {props.detail}
        </Text>
        {props.action ? (
          <Pressable
            testID={`${testID}.action`}
            accessibilityRole="button"
            onPress={props.action.onPress}
            hitSlop={8}
          >
            <Text
              style={[
                styles.text,
                styles.action,
                { color: theme.colors.text.primary },
              ]}
            >
              {props.action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  text: { ...Typography.default(), ...happierPageTextMetrics('pageDescription') },
  title: { ...Typography.default('semiBold'), flexShrink: 1 },
  detail: { flexShrink: 1 },
  action: { ...Typography.default('semiBold') },
}));
