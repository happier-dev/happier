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
import { useOptionalSessionSurfacePresenceSignal } from '@/components/sessions/shell/sessionSurfacePresence';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const NO_PICKED_TASKS: readonly BoardItemRefV1[] = Object.freeze([]);
const NO_PRESENCE_SUBSCRIPTION = () => () => {};

export type SessionHeaderTaskSession = Readonly<{ sessionId: string; scope: ServerAccountScope }>;
export type SessionHeaderTaskLink = Readonly<{ key: string; title: string; href: string }>;

/** Menu row ids for linked Tasks folded into the header's ⋯ (a phone header): `header.task:<item key>`. */
export const SESSION_HEADER_TASK_MENU_ID_PREFIX = 'header.task:';

/**
 * The canonical Tasks linked to one presented Session, each with its owning plugin page. Discovered through
 * the same live Work Items owner as Boards; the header chip and the folded ⋯ rows both read this, only while
 * the Session is presented (outside a Session view it reads nothing).
 */
export function useSessionHeaderTaskLinks(taskSession: SessionHeaderTaskSession | null): readonly SessionHeaderTaskLink[] {
    const presence = useOptionalSessionSurfacePresenceSignal();
    const readPresented = () => presence?.get().presented === true;
    const enabled = React.useSyncExternalStore(presence?.subscribe ?? NO_PRESENCE_SUBSCRIPTION, readPresented, readPresented);
    const scope = taskSession?.scope;
    const inAppScope = useAppShellPluginUiProjection(view => scope !== undefined && areServerAccountScopesEqual(view.accountLifetime?.scope, scope), enabled);
    const serverId = scope?.serverId ?? null;
    const sessionId = taskSession?.sessionId ?? null;
    const sessions = React.useMemo<readonly BoardItemRefV1[]>(() => serverId && sessionId ? [
        { kind: 'session', qualifiedId: { id: sessionId, serverId } },
    ] : NO_PICKED_TASKS, [serverId, sessionId]);
    const tasks = useBoardTaskItems(serverId, NO_PICKED_TASKS, sessions, enabled && inAppScope && sessionId !== null);
    return React.useMemo(() => tasks.linkedRefs.flatMap((ref): SessionHeaderTaskLink[] => {
        if (ref.kind !== 'task') return [];
        const key = buildWorkBoardItemKeyV1(ref);
        const task = tasks.items.get(key);
        if (!task?.page) return [];
        return [{ key, title: task.title, href: buildPluginAppPageRoutePath({
            pluginId: ref.pluginId, localId: task.page.pageId, subPath: task.page.subPath,
        }) }];
    }), [tasks.items, tasks.linkedRefs]);
}

export const SessionHeaderTaskLinks = React.memo(function SessionHeaderTaskLinks(taskSession: SessionHeaderTaskSession) {
    const links = useSessionHeaderTaskLinks(taskSession);
    return links.length > 0 ? <View style={styles.links}>{links.map(link => (
        <TaskLinkChip key={link.key} itemKey={link.key} title={link.title} href={link.href} />
    ))}</View> : null;
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
    // The folder gives way first; a chip truncates its own label only when it alone outgrows the line.
    links: { flexDirection: 'row', flexShrink: 0, maxWidth: '100%', gap: theme.space.s6 },
    chip: { flexShrink: 1, minWidth: 0, borderRadius: HAPPIER_BADGE_METRICS.radius },
}));
