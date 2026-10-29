import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { WidgetGlanceRow } from '@/components/widgets/glance/WidgetGlanceRow';
import {
  useSessionListRelativeNowMs,
  useSessionListRuntimeNowMs,
} from '@/hooks/session/sessionListRuntimeClock';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import {
  buildSessionListReachabilityRenderableKey,
  useSessionListRowRenderablesForItems,
} from '@/sync/domains/state/storage';
import {
  getSessionName,
  getSessionStatus,
} from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { useProjectSessionsWidgetBody } from './useProjectSessionsWidgetBody';

/**
 * Sessions (plan 12, lab p-overview HOME `sessionsW`): this Project's own Sessions, one glance row
 * each — the agent's mark, the Session's name and what it is doing (or when it last did something).
 * Membership, paging and freshness are the Project roster's (`useProjectSessions`); the name and
 * status are the Session list's own owners, so a row says what the Sessions list says.
 */
export function ProjectSessionsWidgetBody(
  props: Readonly<{ checkout: WorkspaceRefV1; testID: string }>,
): React.ReactElement {
  const sessions = useProjectSessionsWidgetBody(props.checkout);
  const router = useRouter();
  const { theme } = useUnistyles();
  const items = sessions.access === 'available' ? sessions.items : [];
  const renderables = useSessionListRowRenderablesForItems(items);
  const hasRenderableSessions = renderables.size > 0;
  const relativeNowMs = useSessionListRelativeNowMs(hasRenderableSessions);
  const runtimeNowMs = useSessionListRuntimeNowMs(hasRenderableSessions);
  const { presentation, query } = sessions;
  const hasMore = Object.values(query.statesByServerId).some(
    (state) => state?.hasNext || state?.attentionHasNext,
  );
  const failed =
    presentation.kind === 'error' || presentation.kind === 'partial';

  if (items.length === 0) {
    if (
      presentation.kind === 'initial_loading' ||
      (presentation.kind === 'refreshing' && !failed)
    ) {
      return (
        <UnavailableInstalledWidget
          unresolved={{
            state: 'loading',
            reasonCode: 'widget_project_sessions_loading',
          }}
          testID={props.testID}
        />
      );
    }
    if (
      sessions.access === 'available' &&
      presentation.kind === 'ready' &&
      presentation.complete &&
      !hasMore
    ) {
      return (
        <View testID={props.testID}>
          <SurfaceStateCard
            testID={`${props.testID}.empty`}
            size="line"
            kind="empty"
            title={t('projects.widgets.sessionsEmpty')}
          />
        </View>
      );
    }
  }

  return (
    <View testID={props.testID}>
      {items.map((item) => {
        const key = buildSessionListReachabilityRenderableKey(
          item.serverId,
          item.sessionId,
        );
        const session = key ? renderables.get(key) : undefined;
        if (!session || !item.serverId) return null;
        const serverId = item.serverId;
        const status = getSessionStatus(session, runtimeNowMs, {
        });
        const activityAt =
          resolveSessionListRenderableMeaningfulActivityAt(session);
        const fact = status.shouldShowStatus
          ? status.statusText
          : typeof activityAt === 'number' && activityAt > 0
            ? formatShortRelativeTimeAt(activityAt, relativeNowMs)
            : null;
        return (
          <WidgetGlanceRow
            key={key}
            testID={`${props.testID}.session:${item.sessionId}`}
            mark={
              <SessionAgentCatalogIdentityIcon
                agentId={readSessionRowPresentationAgentId(session) ?? ''}
                machineId={resolveSessionMachineId(session.metadata)}
                serverId={serverId}
                color={theme.colors.text.primary}
                size={ICON_SIZE.sm}
              />
            }
            title={getSessionName(session, serverId)}
            fact={fact}
            factTone={
              status.state === 'permission_required' ||
              status.state === 'action_required'
                ? 'attention'
                : 'quiet'
            }
            // Always the Session's own Home, never a bare id.
            onPress={() =>
              router.push(
                buildScopedSessionRouteHref({
                  sessionId: item.sessionId,
                  serverId,
                }) as never,
              )
            }
          />
        );
      })}
      {failed ? (
        <SurfaceStateCard
          testID={`${props.testID}.error`}
          size="line"
          kind="error"
          title={t('sessionsList.queryRefreshFailedTitle')}
          action={{
            label: t('common.retry'),
            onPress: () => {
              void query.retry();
            },
          }}
        />
      ) : null}
      {hasMore && !failed ? (
        <WidgetGlanceRow
          testID={`${props.testID}.more`}
          variant="fact"
          mark="caret-down"
          title={t('projects.widgets.sessionsMore')}
          onPress={() => {
            void query.loadNext();
          }}
        />
      ) : null}
    </View>
  );
}
