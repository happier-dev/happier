import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

/**
 * The one quiet line above a shared dashboard's widgets (12s3, `projects.dashboard.identity`): whose
 * it is and what this viewer can do with it, from the admitted Artifact's owner and current access.
 * It never shows on a personal, unshared dashboard: healthy is quiet. No header chip.
 */
export const ProjectDashboardIdentityLine = React.memo(
  function ProjectDashboardIdentityLine(
    props: Readonly<{
      owner: Readonly<{ accountId: string; displayName?: string; imageUrl?: string | null }>;
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
        {props.owner.displayName ? (
          <>
            <Text style={[styles.text, { color: theme.colors.text.tertiary }]}>·</Text>
            {/* Whose dashboard it is, in words: the avatar alone keys on an opaque Account id. */}
            <Text numberOfLines={1} testID={`${testID}.owner`}
              style={[styles.text, styles.owner, { color: theme.colors.text.secondary }]}>
              {props.owner.displayName}
            </Text>
          </>
        ) : null}
        <Text style={[styles.text, { color: theme.colors.text.tertiary }]}>
          ·
        </Text>
        <Text
          numberOfLines={1}
          style={[
            styles.text,
            styles.access,
            { color: theme.colors.text.secondary },
          ]}
        >
          {props.detail}
        </Text>
        {props.action ? (
          <HappierPressable
            testID={`${testID}.action`}
            accessibilityRole="button"
            onPress={props.action.onPress}
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
          </HappierPressable>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  text: { ...Typography.default(), ...happierPageTextMetrics('pageDescription') },
  title: { ...Typography.default('semiBold'), flexShrink: 1 },
  /** The names give way first; the access level the viewer acts under stays whole. */
  owner: { flexShrink: 1 },
  access: { flexShrink: 0 },
  action: { ...Typography.default('semiBold') },
}));
