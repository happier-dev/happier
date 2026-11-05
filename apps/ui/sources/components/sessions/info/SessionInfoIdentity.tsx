import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { IconName } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderTextEditor } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import {
  getSessionAvatarId,
  type SessionStatus,
} from '@/utils/sessions/sessionUtils';

/** The one next step the identity offers while it applies (Unarchive, Resume, Open session to resume). */
export type SessionInfoContextAction = Readonly<{
  id: string;
  label: string;
  icon: IconName;
  loading: boolean;
  onPress: () => void;
}>;

type MenuAction = Readonly<{
  id: string;
  testID: string;
  title: string;
  onSelect: () => void;
}>;

/**
 * Who this Session is, at the top of Info. In the panel, the Session header right above already
 * names it, so the body opens on its live line (status, then agent · machine · folder) and the one
 * contextual action; the route shows the full identity — mark, title and the same lines.
 */
export const SessionInfoIdentity = React.memo(function SessionInfoIdentity(
  props: Readonly<{
    presentation: 'pane' | 'route';
    session: Session;
    sessionName: string;
    agentId: string | null;
    status: SessionStatus;
    meta: readonly string[];
    path: string | null;
    /** The Agent's own mark, leading the meta line (no tile behind it). */
    agentMark?: React.ReactNode;
    contextAction: SessionInfoContextAction | null;
    menuActions: readonly MenuAction[];
    /** The route's in-place rename of the title. */
    titleEditor?: PageHeaderTextEditor;
    onClose: () => void;
  }>,
) {
  const action = props.contextAction ? (
    <RoundButton
      testID={`session-info-context-action:${props.contextAction.id}`}
      size="small"
      display="secondary"
      title={props.contextAction.label}
      onPress={props.contextAction.onPress}
      loading={props.contextAction.loading}
    />
  ) : null;
  const statusLine = (
    <View style={styles.statusLine}>
      <StatusDot
        color={props.status.statusDotColor}
        isPulsing={props.status.isPulsing}
        size={8}
      />
      <Text
        testID="session-info-status"
        style={[styles.statusText, { color: props.status.statusColor }]}
        numberOfLines={1}
      >
        {props.status.statusText}
      </Text>
    </View>
  );
  const metaLine =
    props.meta.length > 0 || props.path ? (
      <View style={styles.metaRow}>
      {props.agentMark ? <View style={styles.metaMark}>{props.agentMark}</View> : null}
      <Text testID="session-info-meta" style={[styles.meta, styles.metaText]}>
        {props.meta.join(' · ')}
        {props.path ? (
          <>
            {props.meta.length > 0 ? ' · ' : ''}
            <Text style={[styles.meta, styles.mono]}>{props.path}</Text>
          </>
        ) : null}
      </Text>
      </View>
    ) : null;

  if (props.presentation === 'route') {
    return (
      <PageHeader
        testID="session-info-header"
        alwaysShowTitle
        cancelAction={{
          title: t('common.close'),
          testID: 'session-info-close',
          onPress: props.onClose,
        }}
        title={props.sessionName}
        titleEditor={props.titleEditor}
        leading={
          <Avatar
            id={getSessionAvatarId(props.session)}
            size={48}
            monochrome={!props.status.isConnected}
            flavor={props.agentId}
          />
        }
        details={
          <View style={styles.routeDetails}>
            <View style={styles.statusRow}>
              {statusLine}
              {action}
            </View>
            {metaLine}
          </View>
        }
        actions={
          props.menuActions.length > 0 ? (
            <PageHeaderMenu
              testID="session-info-menu"
              actions={props.menuActions}
            />
          ) : undefined
        }
      />
    );
  }

  return (
    <ItemGroup surface="none" header="none" testID="session-info-identity" style={styles.identityGroup}>
      <View style={styles.statusRow}>
        {statusLine}
        {action}
      </View>
      {metaLine}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The pane's header band sits right above and already ends in its own air: the live line (held at the
  // control's height for its action) starts at the band's edge, so the identity reads as the header's
  // continuation rather than a block of its own.
  identityGroup: {
    paddingBottom: theme.space.s4,
  },
  routeDetails: {
    gap: theme.space.s4,
    marginTop: theme.space.s4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    minHeight: theme.space.s32,
  },
  statusLine: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  statusText: {
    ...Typography.variant('body', 'medium'),
    flexShrink: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s6,
  },
  metaMark: {
    paddingTop: theme.space.s2,
  },
  metaText: {
    flex: 1,
    minWidth: 0,
  },
  meta: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  mono: {
    ...Typography.mono(),
  },
}));
