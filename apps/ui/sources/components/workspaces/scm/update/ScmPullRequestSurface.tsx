import * as React from 'react';
import { View } from 'react-native';
import { PluginUiLaunchInputV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';

import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { resolveScmPullRequestSurfaceBinding } from './scmPullRequestSurfaceBinding';

/** Physical SCM insertion only; contributed code owns PR relationship and status. */
export function SessionScmPullRequestSurface(props: Readonly<{
    session: SessionAddress;
    pullRequest?: ScmPullRequestSummary;
    origin?: 'createdHere';
    fallback: React.ReactNode;
}>) {
    const runtime = useSessionPluginRuntime({ address: props.session });
    return <ScmPullRequestSurfaceBinding
        runtime={runtime} targetKind="session" sessionId={props.session.sessionId}
        pullRequest={props.pullRequest} origin={props.origin} fallback={props.fallback}
    />;
}

/** A Project has no implicit Session; its admitted app surface owns link selection. */
export function ProjectScmPullRequestSurface(props: Readonly<{
    serverId: string;
    machineId: string;
    pullRequest: ScmPullRequestSummary;
    fallback: React.ReactNode;
}>) {
    const projection = useScopedPluginUiProjection({ serverId: props.serverId, machineId: props.machineId });
    return <ScmPullRequestSurfaceBinding runtime={projection} targetKind="app"
        pullRequest={props.pullRequest} fallback={props.fallback} />;
}

export function ScmPullRequestSurfaceBinding(props: Readonly<{
    runtime: PluginUiProjectionCurrentness;
    targetKind: 'session' | 'app';
    sessionId?: string;
    pullRequest?: ScmPullRequestSummary;
    origin?: 'createdHere';
    fallback: React.ReactNode;
}>) {
    const { runtime } = props;
    const mount = React.useMemo(() => resolveScmPullRequestSurfaceBinding({
        projection: runtime.pluginUiProjection, pullRequest: props.pullRequest, origin: props.origin, targetKind: props.targetKind,
    }), [props.origin, props.pullRequest, props.targetKind, runtime.pluginUiProjection]);
    // This is the existing physical surface transport's JSON/byte boundary,
    // not another SCM or relationship parser.
    const input = React.useMemo(() => mount && runtime.serverId
        ? PluginUiLaunchInputV1Schema.safeParse({ ...mount.launchInput, homeServerId: runtime.serverId })
        : null, [mount, runtime.serverId]);
    if (!mount || !input?.success) return props.fallback;
    // The PR slot sits in a pane's flow above its own list: it takes its content's height (none when the
    // card draws nothing) and never grows into the pane's free room, so the list follows it directly (P03 W4).
    return (
        <View>
            <PluginInlineSurfaceHost
                placement={mount.placement}
                inlineMount={mount.inlineMount}
                launchInput={input.data}
                sessionId={props.sessionId}
                serverId={runtime.serverId}
                machineId={runtime.machineId}
                platform={runtime.platform}
                pluginUiProjection={runtime.pluginUiProjection}
                projectionInteractionEnabled={runtime.phase === 'current' && runtime.interactionEnabled}
            />
        </View>
    );
}
