import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBreadcrumb, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { HEADER_BAND_SUBTITLE_TEXT } from '@/components/ui/layout/headerBand';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

import { describeSessionLineage, useSessionLineage, type SessionLineageAncestor } from './sessionLineage';

type SessionLineagePresentation = 'breadcrumb' | 'reportsTo';

/**
 * The lineage breadcrumb of a Session that reports to a lead (ORC §3.8 header; lab `session-E`): the
 * leads above it, root first, each one a way back up. It sits over the header title, which already
 * names this Session, so the crumb names only the leads. A Session that reports to no one draws nothing.
 */
export const SessionLineageBreadcrumb = React.memo(
  function SessionLineageBreadcrumb(
    props: Readonly<{
      sessionId: string;
      serverId?: string | null;
      presentation?: SessionLineagePresentation;
    }>,
  ) {
    const lineage = useSessionLineage(props.sessionId, props.serverId ?? null);
    return <SessionLineageNavigation lineage={lineage} serverId={props.serverId} presentation={props.presentation} />;
  },
);

/** Work already reads lineage for its header; share its navigation without a second store subscription. */
export const SessionLineageNavigation = React.memo(
  function SessionLineageNavigation(props: Readonly<{
    lineage: readonly SessionLineageAncestor[];
    serverId?: string | null;
    presentation?: SessionLineagePresentation;
  }>) {
    const { lineage } = props;
    const router = useRouter();
    const { theme } = useUnistyles();
    if (lineage.length === 0) return null;
    const label = describeSessionLineage(lineage)!;
    const openAncestor = (sessionId: string) => router.push(buildScopedSessionRouteHref({
      sessionId,
      serverId: props.serverId,
    }) as never);
    if (props.presentation === 'reportsTo') {
      const lead = lineage[lineage.length - 1]!;
      return (
        <HappierPressable
          testID={`session-header-lineage:${lead.sessionId}`}
          accessibilityRole="link"
          accessibilityLabel={label}
          style={[styles.row, { minHeight: resolveMinimumInteractiveTargetSize(Platform.OS) }]}
          onPress={() => openAncestor(lead.sessionId)}
        >
          <Icon name="tree-structure" size={11} color={theme.colors.text.tertiary} />
          <Text numberOfLines={1} style={[styles.label, styles.crumb]}>{label}</Text>
          <Icon name="caret-right" size={10} color={theme.colors.text.tertiary} />
        </HappierPressable>
      );
    }
    return (
      <HappierBreadcrumb
        testID="session-header-lineage"
        style={styles.row}
        accessibilityLabel={label}
        leading={<Icon
          name="tree-structure"
          size={11}
          color={theme.colors.text.tertiary}
        />}
        separator={<Icon name="caret-right" size={10} color={theme.colors.text.tertiary} />}
        colors={{ focus: theme.colors.border.focus, hover: theme.colors.surface.pressed }}
        linkStyle={styles.crumb}
        items={lineage.map((ancestor) => ({ key: ancestor.sessionId, label: ancestor.title, testID: `session-header-lineage:${ancestor.sessionId}`, onPress: () => openAncestor(ancestor.sessionId) }))}
        renderLabel={(item) => <Text numberOfLines={1} style={styles.label}>{item.label}</Text>}
      />
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
    maxWidth: '100%',
  },
  crumb: {
    flexShrink: 1,
    minWidth: 0,
  },
  label: {
    ...Typography.default(),
    fontSize: HEADER_BAND_SUBTITLE_TEXT.fontSize,
    lineHeight: HEADER_BAND_SUBTITLE_TEXT.lineHeight,
    color: theme.colors.text.secondary,
  },
}));
