import * as React from 'react';

import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import {
    useSessionAddressForSessionId,
    useSessionPluginRuntime,
} from '@/components/sessions/plugins/useSessionPluginRuntime';
import { createPluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { selectRenderablePluginInlineSurfacePlacementsForRole } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

const SESSION_WORK_SECTION_INLINE_MOUNT = Object.freeze({
    role: 'sessionWorkSection' as const,
    presentation: 'content' as const,
});

/**
 * Host contribution slot for inline plugin sections inside a Session's Work tab (`SessionWorkView`).
 *
 * Mounts every admitted `sessionWorkSection` contribution for this exact Session through the
 * canonical `PluginInlineSurfaceHost` without hardcoding any plugin id in core UI.
 */
export const SessionWorkPluginSections = React.memo(function SessionWorkPluginSections(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): React.ReactElement | null {
    const sessionAddress = useSessionAddressForSessionId(props.sessionId, props.serverId ?? undefined);
    const runtime = useSessionPluginRuntime({ address: sessionAddress });
    const runtimePlatform = runtime?.platform;
    const policyContext = React.useMemo(
        () => (runtimePlatform ? createPluginUiPolicyEvaluationContext(undefined, { platform: runtimePlatform, channel: 'internal' }) : undefined),
        [runtimePlatform],
    );
    const placements = React.useMemo(() => {
        if (!runtime?.pluginUiProjection) return null;
        const matched = selectRenderablePluginInlineSurfacePlacementsForRole(
            runtime.pluginUiProjection,
            'sessionWorkSection',
            policyContext,
        ).filter((placement) => placement.binding.targetKind === 'session');
        return matched.length > 0 ? matched : null;
    }, [policyContext, runtime?.pluginUiProjection]);

    if (!runtime || !placements) return null;

    const interactionEnabled = runtime.phase === 'current' && runtime.interactionEnabled;
    return (
        <>
            {placements.map((placement) => (
                <PluginInlineSurfaceHost
                    key={placement.id}
                    placement={placement}
                    inlineMount={SESSION_WORK_SECTION_INLINE_MOUNT}
                    sessionId={props.sessionId}
                    serverId={runtime.serverId}
                    machineId={runtime.machineId}
                    platform={runtime.platform}
                    pluginUiProjection={runtime.pluginUiProjection}
                    projectionInteractionEnabled={interactionEnabled}
                />
            ))}
        </>
    );
});
