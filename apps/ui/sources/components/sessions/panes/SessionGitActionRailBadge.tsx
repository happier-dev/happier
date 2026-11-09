import * as React from 'react';
import { useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { GitActionRailTooltip } from '@/components/ui/navigation/tabBadge/GitActionRailTooltip';
import { GitActionRailBadge } from '@/components/ui/navigation/tabBadge/GitActionRailBadge';
import type { RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';

// Keep SCM updates local to the badge, as in the mobile cockpit's canonical badge model.
export const SessionGitActionRailBadge = React.memo((props: Readonly<{ sessionId: string; serverId?: string | null; renderSignal?: RailBadgeSignalRenderer }>) => {
    const scmStatus = useSessionProjectScmStatus(props.sessionId, props.serverId);
    const mode = useSetting('tabBarGitBadgeMode');
    return <GitActionRailBadge scmStatus={scmStatus} mode={mode} renderSignal={props.renderSignal} testID="session-action-rail:git:badge" />;
});

// The tooltip mounts on hover/focus and reads the same scoped cached summary.
export function SessionGitActionRailTooltip(props: Readonly<{ sessionId: string; serverId?: string | null }>) {
    return <GitActionRailTooltip scmStatus={useSessionProjectScmStatus(props.sessionId, props.serverId)} />;
}
