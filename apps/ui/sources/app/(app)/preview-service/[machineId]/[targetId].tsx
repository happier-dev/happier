import * as React from 'react';
import {
    formatLocalServiceDeclarationPreviewLandingPathV1,
    parseLocalServiceDeclarationPreviewLandingUrlV1,
    type LocalServiceDeclarationPreviewLocatorV1,
} from '@happier-dev/protocol/local/services/preview/v1';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { BrowserDetailsSurface } from '@/components/browser/surfaces/browserDetailsSurfaceRenderer';
import {
    describeLocalServiceActionFailure,
    readLocalServiceActionOutcome,
} from '@/components/sessions/localServices/localServiceActionOutcome';
import { UnboundSessionHomeScopeCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    resolveLocalServiceBrowserTarget,
    type LocalServiceBrowserTargetResult,
} from '@/sync/domains/local/services/preview/resolveLaunchTarget';
import { t } from '@/text';

const testID = 'private-service-preview';

export function WorkspaceRouteBody() {
    const { serverId, machineId, targetId } = useLocalSearchParams<{ serverId?: string; machineId?: string; targetId?: string }>();
    const locator = React.useMemo(() => {
        if (typeof serverId !== 'string' || typeof machineId !== 'string' || typeof targetId !== 'string') return null;
        return parseLocalServiceDeclarationPreviewLandingUrlV1(
            new URL(formatLocalServiceDeclarationPreviewLandingPathV1({ serverId, machineId, targetId }), 'https://route.invalid').href,
        );
    }, [serverId, machineId, targetId]);
    if (!locator) return <SurfaceStateCard kind="unavailable" title={t('localServices.source.preview')}
        reason={t('localServices.actions.failure.browserViewUnavailable')} />;
    return <PrivatePreviewLanding key={JSON.stringify(locator)} locator={locator} />;
}

function PrivatePreviewLanding({ locator }: Readonly<{ locator: LocalServiceDeclarationPreviewLocatorV1 }>) {
    const { binding, resolution, executeForCaller } = useMountedActionExecution(locator.serverId);
    const router = useRouter();
    const [attempt, setAttempt] = React.useState(0);
    const [settled, setSettled] = React.useState<{
        binding: NonNullable<typeof binding>;
        attempt: number;
        result: LocalServiceBrowserTargetResult | null;
    } | null>(null);
    React.useEffect(() => {
        if (!binding) return;
        const controller = new AbortController();
        void resolveLocalServiceBrowserTarget(locator, {
            accountLifetime: binding,
            execute: async (request, context) => {
                const result = await executeForCaller('localServices.preview.openOrCreate', request, context, {
                    signal: controller.signal,
                });
                return result.ok ? result.result : result;
            },
        }).then(result => {
            if (!controller.signal.aborted) setSettled({ binding, attempt, result });
        }, () => {
            if (!controller.signal.aborted) setSettled({ binding, attempt, result: null });
        });
        return () => controller.abort();
    }, [attempt, binding, executeForCaller, locator]);

    if (resolution.kind !== 'bound') {
        return <UnboundSessionHomeScopeCard resolution={resolution} serverId={locator.serverId} testIDPrefix={testID} />;
    }
    if (!binding || settled?.binding !== binding || settled.attempt !== attempt) {
        return <SurfaceStateCard testID={`${testID}-opening`} kind="loading" title={t('localServices.source.preview')} />;
    }
    const { result } = settled;
    if (result && 'status' in result && result.status === 'succeeded') {
        return <BrowserDetailsSurface
            presentationSlotId={JSON.stringify([binding.scope.serverId, locator.machineId, locator.targetId])}
            keepAliveAboveRouter={false}
            resource={{ kind: 'browserSurface', target: result.target, currentUrl: result.currentUrl }}
            serverId={binding.scope.serverId}
            machineId={locator.machineId}
            pluginAccountLifetime={binding}
            localServicePreviewServerId={binding.scope.serverId}
            launchpadRows={[]}
            testID={testID}
        />;
    }
    const outcome = readLocalServiceActionOutcome(result);
    const refused = outcome.kind === 'failed' || outcome.kind === 'outcome_unknown' ? outcome : null;
    const failure = describeLocalServiceActionFailure(refused ?? { reasonCode: 'preview_target_unresolved' });
    return <SurfaceStateCard testID={`${testID}-unavailable`} kind={failure.refusal ? 'denied' : 'unavailable'}
        title={failure.title} reason={failure.body}
        diagnosticCode={refused?.reasonCode}
        diagnosticDetail={failure.details.filter(line => line !== refused?.reasonCode).join('\n')}
        action={{ label: t('common.retry'), testID: `${testID}-retry`, onPress: () => setAttempt(value => value + 1) }}
        secondaryAction={{ label: t('projects.identity.backToProjects'), onPress: () => router.push('/projects') }} />;
}

export default function PrivateLocalServicePreviewRoute() {
    return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />;
}
