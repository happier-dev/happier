import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionElapsedClock } from '@/components/sessions/companion/summary/SessionSummaryStatusLine';
import { SessionAvatar } from '@/components/sessions/bots/face/SessionAvatar';
import { SharedBotPetOffer } from '@/components/sessions/bots/SharedBotPetOffer';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderTextEditor } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { readSessionTurnStartedAtMs } from '@/sync/domains/session/awareness/useSessionAwareness';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import {
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
 * Who this Session is, at the top of Info, in two lines: the live one (status · Agent · model) and
 * where it runs (machine · folder, in mono). In the panel, the Session header right above already
 * names it, so the body opens on those lines with the one contextual action beside the status. The
 * route shows the full identity through the page header: the Agent's mark in the header's mark slot,
 * the title, the same two lines, then the action under them (phone lab p5 "Session Info", D15).
 */
export const SessionInfoIdentity = React.memo(function SessionInfoIdentity(
  props: Readonly<{
    presentation: 'pane' | 'route';
    session: Session;
    sessionName: string;
    agentId: string | null;
    status: SessionStatus;
    /** What runs it, after the status: Agent, model. */
    meta: readonly string[];
    /** Where it runs: the machine, then the folder. */
    machine: string | null;
    path: string | null;
    /** The Agent's own mark at the given glyph size (no tile behind it): the route header's mark. */
    renderAgentMark?: (sizePx: number) => React.ReactNode;
    contextAction: SessionInfoContextAction | null;
    /** A Bot's face: a shared Bot wearing a catalog pet the viewer lacks offers "Add <pet>" under where it runs (PET-SHARE). */
    botFace?: SessionBotFaceV1 | null;
    menuActions: readonly MenuAction[];
    /** The route's in-place rename of the title. */
    titleEditor?: PageHeaderTextEditor;
    onClose: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  // The one next step, quiet beside the status it answers (lab csinfo I2min "Resume"): the pane's small
  // labelled action, never a call-to-action slab.
  const action = props.contextAction ? (
    <ToolbarButton
      testID={`session-info-context-action:${props.contextAction.id}`}
      label={props.contextAction.label}
      icon={<Icon name={props.contextAction.icon} size={12} color={theme.colors.text.primary} />}
      onPress={props.contextAction.onPress}
      // In the pane the place line sits right under the button (nothing is free below it); the free space is
      // above, the pane header band's lower air. On the route it closes the header: the section gap is below.
      hitReach={props.presentation === 'route' ? { top: 0, bottom: theme.space.s12 } : { top: theme.space.s12, bottom: 0 }}
      busy={props.contextAction.loading}
      disabled={props.contextAction.loading}
    />
  ) : null;
  const turnStartedAtMs = readSessionTurnStartedAtMs(props.session);
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
      {/* While a turn runs, how long it has (lab csinfo I2 "Working · 4 min"): the one shared clock. */}
      {turnStartedAtMs !== null ? (
        <>
          <Text style={styles.statusElapsed} aria-hidden>·</Text>
          <SessionElapsedClock sinceMs={turnStartedAtMs} testID="session-info-status-elapsed" style={styles.statusElapsed} />
        </>
      ) : null}
      {props.meta.length > 0 ? (
        <Text testID="session-info-facts" style={[styles.statusElapsed, styles.fact]} numberOfLines={1}>
          {`· ${props.meta.join(' · ')}`}
        </Text>
      ) : null}
    </View>
  );
  const place = [props.machine, props.path].filter((part): part is string => Boolean(part));
  const placeLine = place.length > 0 ? (
    <Text testID="session-info-meta" style={[styles.meta, styles.mono]}>{place.join(' · ')}</Text>
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
        // The mark and the menu hang from the title's first line, however many lines the name takes.
        actionsLayout="hang"
        leading={
          <PageHeaderMarkSlot testID="session-info-mark">
            {props.renderAgentMark?.(HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx) ?? (
              <SessionAvatar
                session={props.session}
                serverId={props.session.serverId}
                size={HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx}
                monochrome={!props.status.isConnected}
                flavor={props.agentId}
              />
            )}
          </PageHeaderMarkSlot>
        }
        details={
          <View style={styles.routeDetails}>
            {statusLine}
            {placeLine}
            <SharedBotPetOffer face={props.botFace} />
            {action ? <View style={styles.routeAction}>{action}</View> : null}
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
      {placeLine}
      <SharedBotPetOffer face={props.botFace} style={styles.paneOffer} />
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
  // The header already puts its line gap above the details; the lines keep that same gap between them.
  routeDetails: {
    gap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx,
  },
  // The offer is its own beat under the place line, like the route's action.
  paneOffer: {
    marginTop: theme.space.s8,
  },
  // The action closes the identity: its own beat under the place line, on the title's edge.
  routeAction: {
    flexDirection: 'row',
    marginTop: theme.space.s8,
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
    gap: theme.space.s6,
  },
  statusText: {
    ...Typography.variant('body', 'medium'),
    flexShrink: 1,
  },
  statusElapsed: {
    ...Typography.variant('body'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
  // A long model name gives way before the status does.
  fact: {
    flexShrink: 1,
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
