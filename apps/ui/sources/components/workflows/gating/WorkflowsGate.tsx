import * as React from 'react';
import { useDestinationParams } from '@/components/appShell/workspace/DestinationInstanceHost';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { resolveFeatureToggleHref } from '@/components/settings/features/featuresSettings';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveWorkflowsUnavailablePresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useWorkflowsDestinationAccess } from './workflowsDestinationAccess';

/**
 * Mounts Workflow content only on the canonical enabled decision (FIN 07 S21). Loading keeps a
 * stable shell; a local-policy disablement names its repair (**Open Settings**); a hard denial says
 * Workflows are unavailable here and offers nothing it cannot deliver.
 *
 * `surface="destination"` is the Workflows home, which also governs triggers.
 */
export function WorkflowsGate(props: Readonly<{
    children: React.ReactNode;
    surface?: 'destination' | 'workflow' | 'occurrence';
}>): React.ReactElement {
    const params = useDestinationParams<{ serverId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
    const access = useWorkflowsDestinationAccess(serverId);
    const router = useRouter();
    const experimentsEnabled = useSetting('experiments') === true;

    if (access.kind === 'resolving') {
        return (
            <SurfaceStateCard
                testID="workflows-gate-loading"
                kind="loading"
                title={t('workflows.editor.loadingTitle')}
                accessibilitySemantics="status"
            />
        );
    }

    if (access.kind === 'locallyDisabled') {
        const destination = props.surface === 'destination';
        const settingHref = resolveFeatureToggleHref('workflows', experimentsEnabled);
        return (
            <SurfaceStateCard
                testID="workflows-gate-local"
                kind="unavailable"
                title={t(destination ? 'workflows.destination.gate.localTitle' : 'workflows.destination.gate.dependencyTitle')}
                reason={t(destination ? 'workflows.destination.gate.localBody' : 'workflows.destination.gate.dependencyBody')}
                {...(settingHref === undefined ? {} : {
                    action: {
                        label: t('workflows.destination.gate.openSettings'),
                        onPress: () => router.push(settingHref as never),
                    },
                })}
                accessibilitySemantics="status"
            />
        );
    }

    if (access.kind !== 'workflows') {
        // An unavailable capability is not a failed read: the canonical Workflow problem mapping
        // owns this state, its copy and the fact that there is no repair to offer here.
        const unavailable = resolveWorkflowsUnavailablePresentation();
        return (
            <SurfaceStateCard
                testID="workflows-gate-disabled"
                kind="unavailable"
                title={unavailable.title}
                reason={unavailable.message}
                accessibilitySemantics={unavailable.accessibilitySemantics}
            />
        );
    }

    return <>{props.children}</>;
}
