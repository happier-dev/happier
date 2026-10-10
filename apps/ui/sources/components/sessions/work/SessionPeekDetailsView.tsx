import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionInPane } from '@/components/sessions/panes/SessionInPane';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { describeSessionLineage, useSessionLineage } from './sessionLineage';
import { SessionWorkNotifications } from './SessionWorkNotifications';

/**
 * The peek of a Session the lead leads (lab `session-D`): the Session itself — its header, real
 * transcript and composer — beside the lead. The header names the Session and who it reports to;
 * replies go to the peeked Session, and the line under the composer says so, because the pane sits
 * next to the lead's own composer. "Notify me when this needs me" lives here, once, for the Session
 * being looked at, rather than under every Work row.
 */

const stylesheet = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  banner: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
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
        <View>
          <Text
            testID="session-peek-replies-banner"
            numberOfLines={1}
            style={styles.banner}
          >
            {t('sessionWork.peek.repliesGoHere')}
          </Text>
          <SessionWorkNotifications
            sessionId={props.sessionId}
            serverId={props.serverId}
          />
        </View>
      ),
      [props.serverId, props.sessionId, styles.banner],
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
  const title = session ? getSessionName(session) : null;
  const agentId = session ? readSessionPresentationAgentId(session) : null;
  const lineage = useSessionLineage(props.sessionId, props.serverId);
  const lineageDescription = describeSessionLineage(lineage);
  const router = useRouter();
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
  if (title === null) return null;
  return (
    <DetailsTabHeader
      testID="session-peek-header"
      title={title}
      leading={
        agentId ? <ExecutionRunAgentMark agentId={agentId} size={28} /> : undefined
      }
      meta={meta}
      actions={!props.openControl ? undefined : (
        <IconButton
          testID="session-peek-open"
          // Not ⤢: the pane's own chrome uses that to widen the pane. This leaves for the session.
          iconName="arrow-square-out"
          variant="plain"
          accessibilityLabel={t('inbox.work.groups.openSession')}
          tooltip={t('inbox.work.groups.openSession')}
          onPress={openSession}
        />
      )}
    />
  );
});
