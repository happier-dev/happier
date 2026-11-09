import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  happierFocusRingStyle,
} from '@happier-dev/plugin-ui/presentation';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { t } from '@/text';

import { readAnchoredDiscussionSourceLinks } from './discussionRoutes';

type SourceMarker = Readonly<{
  discussionId: string;
  title: string | null;
  href: string;
}>;
type SourceMarkers = Readonly<{
  forMessage: (source: SessionMessageRefV1) => readonly SourceMarker[];
}>;

const NO_MARKERS: readonly SourceMarker[] = [];
const SessionDiscussionSourceLinksContext =
  React.createContext<SourceMarkers | null>(null);

/**
 * The Discussions hanging off this Session's answers (lab T3-D "Second opinion · … answered"), read once per
 * Session from the anchored Discussion list the People pane and Talk choices already share. Rows only look
 * their answer up; they never ask the Home or keep their own copy.
 */
export function SessionDiscussionSourceLinksProvider(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    children: React.ReactNode;
  }>,
) {
  const { binding: resolvedBinding } = useServerCredentialAccountScopeBinding(
    props.serverId ?? undefined,
  );
  const binding = props.serverId && resolvedBinding?.isCurrent() ? resolvedBinding : null;
  const { sessionId } = props;
  const serverId = binding?.scope.serverId ?? null;
  const address = React.useMemo(() => serverId ? { serverId } : null, [serverId]);
  const client = React.useMemo(
    () => binding ?
      createDiscussionClient({
        scope: binding.scope,
        availability: 'available',
      }) : null,
    [binding?.scope],
  );
  const repository = React.useMemo(
    () => binding && address && client ?
      getDiscussionRepository({
        scope: binding.scope,
        address,
        client,
        accountLifetime: binding,
      }) : null,
    [address, binding, client],
  );
  useDiscussionRepositorySnapshot(repository);
  React.useEffect(() => {
    if (!repository) return;
    const unmount = repository.mount({ anchorSessionId: sessionId });
    if (repository.getListSnapshot(sessionId).lists.active.status === 'idle')
      void repository.refreshAnchoredList(sessionId, 'active');
    return unmount;
  }, [repository, sessionId]);
  const discussions = repository?.getListSnapshot(sessionId).lists.active.items;
  const value = React.useMemo<SourceMarkers | null>(() => {
    if (!address || !discussions) return null;
    const titles = new Map(
      discussions.map((discussion) => [
        discussion.id,
        discussion.title ?? null,
      ]),
    );
    return {
      forMessage: (source) => {
        const links = readAnchoredDiscussionSourceLinks({
          address,
          source,
          discussions,
        });
        return links.length === 0
          ? NO_MARKERS
          : links.map((link) => ({
              discussionId: link.discussion.discussionId,
              title: titles.get(link.discussion.discussionId) ?? null,
              href: link.href,
            }));
      },
    };
  }, [address, discussions]);
  // Scope hydration changes marker availability, never the transcript's position.
  // Inserting a wrapper here would discard its consumed Find launch and local state.
  return (
    <SessionDiscussionSourceLinksContext.Provider value={value}>
      {props.children}
    </SessionDiscussionSourceLinksContext.Provider>
  );
}

/** The persistent way from an answer to each Discussion started on it; nothing renders for an answer without one. */
export const DiscussionSourceMarkers = React.memo(
  function DiscussionSourceMarkers(
    props: Readonly<{
      source: SessionMessageRefV1 | null;
      navigate: ((href: string) => void) | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const context = React.useContext(SessionDiscussionSourceLinksContext);
    const markers =
      props.source && context ? context.forMessage(props.source) : NO_MARKERS;
    if (markers.length === 0 || !props.navigate) return null;
    const navigate = props.navigate;
    return (
      <>
        {markers.map((marker) => {
          const title =
            marker.title ??
            t('session.collaboration.discussion.encryptedTitle');
          return (
            <HappierPressable
              key={marker.discussionId}
              testID={`transcript-message-discussion:${marker.discussionId}`}
              accessibilityRole="link"
              accessibilityLabel={t(
                'session.collaboration.discussion.openAnchor',
                { name: title },
              )}
              onPress={() => navigate(marker.href)}
              style={({ pressed, focused, hovered }) => [
                styles.marker,
                hovered || pressed ? styles.markerActive : null,
                happierFocusRingStyle({
                  visible: focused,
                  color: theme.colors.border.focus,
                }),
              ]}
            >
              <Icon
                name="scales"
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Icon
                name="caret-right"
                size={ICON_SIZE.xs}
                color={theme.colors.text.tertiary}
              />
            </HappierPressable>
          );
        })}
      </>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  // Lab flows `asked`/`backP`: the one way back from an answer to what was started on it, a full-width
  // line under the answer (mark, what it is, Open), so it reads as the answer's own result, not a chip.
  marker: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: theme.space.s8,
    minHeight: 28,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    marginTop: theme.space.s8,
    borderRadius: theme.borderRadius.md,
    ...resolveThemeHairlineBorderStyle(theme.colors.border.surface),
  },
  markerActive: { backgroundColor: theme.colors.surface.pressed },
  title: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.primary,
    flex: 1,
    minWidth: 0,
  },
}));
