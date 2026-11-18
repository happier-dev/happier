import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionInPane } from '@/components/sessions/panes/SessionInPane';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { t } from '@/text';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';

import { describeSessionLineage, useSessionLineage } from './sessionLineage';
import { SessionFollowHeaderChip } from '@/components/sessions/follow/SessionFollowHeaderChip';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { useSessionExternalRuntimePresentation } from '@/components/sessions/presentation/useSessionExternalRuntimePresentation';
import { SessionHeaderExternalAgentStatus } from '@/components/sessions/shell/view/SessionHeaderExternalAgentStatus';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

/**
 * The peek of a Session the lead leads (lab `session-D`): the Session itself — its header, real
 * transcript and composer — beside the lead. The header names the Session and who it reports to;
 * replies go to the peeked Session, and the line under the composer says so, because the pane sits
 * next to the lead's own composer. "Notify me when this finishes / needs me" is the Session's own
 * Follow editor, opened from the header bell beside Open session (the same control the Session
 * header's Follow chip opens), never a second set of switches under the composer.
 */

const stylesheet = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  banner: {
    color: theme.colors.text.tertiary,
    ...Typography.variant('meta'),
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s10,
  },
}));

export const SessionPeekDetailsView = React.memo(
  (
    props: Readonly<{
      sessionId: string;
      serverId?: string | null;
      active: boolean;
      /**
       * Whether the header offers "Open session". A host whose own chrome already leaves for the
       * session's page (the Inbox's detail pane) turns it off, so the header never shows two.
       */
      openControl?: boolean;
    }>,
  ) => {
    const styles = stylesheet;
    const banner = React.useMemo(
      () => (
        <Text
          testID="session-peek-replies-banner"
          numberOfLines={1}
          style={styles.banner}
        >
          {t('sessionWork.peek.repliesGoHere')}
        </Text>
      ),
      [styles.banner],
    );
    return (
      <View style={styles.root}>
        {props.active ? (
          <SessionPeekHeader
            sessionId={props.sessionId}
            serverId={props.serverId ?? null}
            openControl={props.openControl !== false}
          />
        ) : null}
        <SessionInPane
          sessionId={props.sessionId}
          serverId={props.serverId ?? null}
          active={props.active}
          composer
          repliesBanner={banner}
        />
      </View>
    );
  },
);

/** The peeked Session's own name and lead (lab `session-D`), read live while the peek is open. */
const SessionPeekHeader = React.memo(function SessionPeekHeader(
  props: Readonly<{ sessionId: string; serverId: string | null; openControl: boolean }>,
) {
  const session = useSessionViewShellSession(props.sessionId, props.serverId);
  const title = sessionDisplayTitle(session ?? null, props.serverId);
  const agentId = session ? readSessionPresentationAgentId(session) : null;
  const lineage = useSessionLineage(props.sessionId, props.serverId);
  const lineageDescription = describeSessionLineage(lineage);
  const router = useRouter();
  const followAnchorRef = React.useRef<View>(null);
  const follow = useAccountSessionFollowEditorHost({ serverId: props.serverId, sessionId: props.sessionId, anchorRef: followAnchorRef });
  const archived = session?.archivedAt != null;
  // The embedded Session draws no header of its own, so the external Agent's live state (needs input, working)
  // stands here, through the same owner and pill as the Session page header.
  const externalAgent = useSessionExternalRuntimePresentation(
    session ?? null,
    readExternalSessionLink(session ? readSessionOwnerMetadataView(session) : null) !== null,
    true,
  )?.externalAgent;
  const { theme } = useUnistyles();
  const meta = React.useMemo(
    () =>
      lineageDescription
        ? [
            {
              key: 'reports-to',
              text: lineageDescription,
            },
          ]
        : [],
    [lineageDescription],
  );
  const openSession = React.useCallback(() => {
    router.push(
      buildScopedSessionRouteHref({
        sessionId: props.sessionId,
        serverId: props.serverId,
      }) as never,
    );
  }, [props.serverId, props.sessionId, router]);
  // The peeked transcript stands on the conversation column; its header stands on the same edges.
  const conversationColumnPx = useLayoutMaxWidth('conversation');
  if (title === null) return null;
  return (
    <DetailsTabHeader
      testID="session-peek-header"
      columnMaxWidthPx={conversationColumnPx}
      title={title}
      leading={
        agentId ? <ExecutionRunAgentMark agentId={agentId} size={28} /> : undefined
      }
      meta={meta}
      actions={(
        <>
          <SessionHeaderExternalAgentStatus
            sessionId={props.sessionId}
            externalAgent={externalAgent}
            color={theme.colors.text.secondary}
          />
          {follow.enabled && props.serverId ? (
            <SessionFollowHeaderChip
              sessionId={props.sessionId}
              serverId={props.serverId}
              compact
              anchorRef={followAnchorRef}
              open={follow.open}
              onPress={() => follow.openEditor({ address: { serverId: props.serverId!, sessionId: props.sessionId }, archived })}
            />
          ) : null}
          {follow.editor}
          {props.openControl ? (
            <IconButton
              testID="session-peek-open"
              // Not ⤢: the pane's own chrome uses that to widen the pane. This leaves for the session.
              iconName="arrow-square-out"
              variant="plain"
              accessibilityLabel={t('inbox.work.groups.openSession')}
              tooltip={t('inbox.work.groups.openSession')}
              onPress={openSession}
            />
          ) : null}
        </>
      )}
    />
  );
});
