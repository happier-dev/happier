import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_BADGE_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useBoardTaskItems } from '@/components/boards/model/useBoardTaskItems';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { useOptionalSessionScreenTestId } from '@/components/sessions/shell/sessionScreenTestIds';
import { useSessionSurfacePresence } from '@/components/sessions/shell/sessionSurfacePresence';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const NO_PICKED_TASKS: readonly BoardItemRefV1[] = Object.freeze([]);

export const SessionHeaderTaskLinks = React.memo(function SessionHeaderTaskLinks(
    { sessionId, scope }: Readonly<{ sessionId: string; scope: ServerAccountScope }>,
) {
    const { presented } = useSessionSurfacePresence();
    const inAppScope = useAppShellPluginUiProjection(view => areServerAccountScopesEqual(view.accountLifetime?.scope, scope), presented);
    const { serverId } = scope;
    // Discover through the same live Work Items owner as Boards, qualified to this one presented Session.
    const sessions = React.useMemo<readonly BoardItemRefV1[]>(() => [
        { kind: 'session', qualifiedId: { id: sessionId, serverId } },
    ], [serverId, sessionId]);
    const tasks = useBoardTaskItems(serverId, NO_PICKED_TASKS, sessions, presented && inAppScope);
    const links = tasks.linkedRefs.flatMap(ref => {
        if (ref.kind !== 'task') return [];
        const key = buildWorkBoardItemKeyV1(ref);
        const task = tasks.items.get(key);
        if (!task?.page) return [];
        return [<TaskLinkChip key={key} itemKey={key} title={task.title} href={buildPluginAppPageRoutePath({
            pluginId: ref.pluginId, localId: task.page.pageId, subPath: task.page.subPath,
        })} />];
    });
    return links.length > 0 ? <View style={styles.links}>{links}</View> : null;
});

function TaskLinkChip({ itemKey, title, href }: Readonly<{ itemKey: string; title: string; href: string }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const testID = useOptionalSessionScreenTestId(`session-header-task-chip:${itemKey}`);
    return <HappierPressable testID={testID} accessibilityRole="link" accessibilityLabel={title}
        onPress={() => router.push(href as never)} style={({ focused }) => [styles.chip,
            focusRingStyle({ focused, color: theme.colors.border.focus })]}>
        <StatusPill variant="neutral" label={title} labelVariant="phrase" labelNumberOfLines={1}
            leading={<Icon name="check-square" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />} style={styles.chip} />
    </HappierPressable>;
}

const styles = StyleSheet.create(theme => ({
    links: { flexDirection: 'row', flexShrink: 1, minWidth: 0, gap: theme.space.s6 },
    chip: { flexShrink: 1, minWidth: 0, borderRadius: HAPPIER_BADGE_METRICS.radius },
}));
