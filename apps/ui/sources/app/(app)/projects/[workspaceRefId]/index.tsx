import * as React from 'react';
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { resolveProjectRightTabId } from '@/components/projects/detail/resolveProjectRightTabId';
import { useDeviceType } from '@/utils/platform/responsive';

export default React.memo(() => {
    const params = useLocalSearchParams<{ workspaceRefId?: string | string[] }>();
    const raw = params.workspaceRefId;
    const workspaceRefId = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
            ? (raw[0] ?? '')
            : '';
    const deviceType = useDeviceType();
    const scopeId = buildProjectPaneScopeId(workspaceRefId);
    const pane = useAppPaneScope(scopeId);

    if (workspaceRefId && deviceType === 'phone') {
        const activeTabId = resolveProjectRightTabId(pane.scopeState?.right?.activeTabId);
        const href = `/projects/${encodeURIComponent(workspaceRefId)}/${activeTabId}` as Href;
        return <Redirect href={href} />;
    }

    return (
        <ProjectDetailScreen workspaceRefId={workspaceRefId} />
    );
});
