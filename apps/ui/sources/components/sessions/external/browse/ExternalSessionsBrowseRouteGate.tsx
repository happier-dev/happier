import * as React from 'react';
import { useRouter } from 'expo-router';
import type { FeatureDecision } from '@happier-dev/protocol';

import { SurfaceStateCard, type SurfaceStateKind } from '@/components/ui/surfaces/SurfaceStateCard';
import type { FeatureDecisionScopeParams } from '@/hooks/server/useFeatureDecision';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { resolveFeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

type BrowseRouteGateTitleKey =
    | 'common.loading'
    | 'externalSessions.browseRouteUnavailableTitle'
    | 'externalSessions.browseRouteAvailabilityUnknownTitle';

type BrowseRouteGateReasonKey =
    | 'externalSessions.browseRouteUnavailableSubtitle'
    | 'externalSessions.browseRouteAvailabilityUnknownSubtitle';

export type ExternalSessionsBrowseRouteGatePresentation = Readonly<{
    testID: string;
    kind: Extract<SurfaceStateKind, 'loading' | 'unavailable' | 'error'>;
    accessibilitySemantics: 'status' | 'alert';
    titleKey: BrowseRouteGateTitleKey;
    reasonKey: BrowseRouteGateReasonKey | null;
}>;

/**
 * The one Browse-route admission presentation, shared by the canonical route,
 * the predecessor redirect and the resume picker.
 *
 * A gate that is still resolving, that failed its probe, and that is genuinely
 * turned off are three different facts, and none of them may render as a blank
 * screen with no way out: every arm returns an accessible state with a working
 * exit. `null` is reserved for "admitted" — the only case where the Browse
 * children (and therefore any Browse RPC) may mount.
 */
export function resolveExternalSessionsBrowseRouteGatePresentation(
    decision: FeatureDecision | null,
): ExternalSessionsBrowseRouteGatePresentation | null {
    const arm = resolveFeatureAvailabilityArm(decision);
    if (arm === 'available') return null;
    if (arm === 'checking') {
        return {
            testID: 'external-sessions-browse-route-gate-checking',
            kind: 'loading',
            accessibilitySemantics: 'status',
            titleKey: 'common.loading',
            reasonKey: null,
        };
    }
    if (arm === 'unknown') {
        return {
            testID: 'external-sessions-browse-route-gate-unknown',
            kind: 'error',
            accessibilitySemantics: 'alert',
            titleKey: 'externalSessions.browseRouteAvailabilityUnknownTitle',
            reasonKey: 'externalSessions.browseRouteAvailabilityUnknownSubtitle',
        };
    }
    return {
        testID: 'external-sessions-browse-route-gate-unavailable',
        kind: 'unavailable',
        accessibilitySemantics: 'alert',
        titleKey: 'externalSessions.browseRouteUnavailableTitle',
        reasonKey: 'externalSessions.browseRouteUnavailableSubtitle',
    };
}

export function ExternalSessionsBrowseRouteGate(props: React.PropsWithChildren<Readonly<{
    scope?: FeatureDecisionScopeParams;
}>>): React.ReactElement {
    const decision = useFeatureDecision('sessions.direct', props.scope);
    const router = useRouter();
    const presentation = resolveExternalSessionsBrowseRouteGatePresentation(decision);
    const onExit = React.useCallback(
        () => safeRouterBack({ router, fallbackHref: '/' }),
        [router],
    );

    if (!presentation) {
        return <>{props.children}</>;
    }

    const exitAction = {
        label: t('common.close'),
        onPress: onExit,
    };
    return (
        <SurfaceStateCard
            testID={presentation.testID}
            kind={presentation.kind}
            accessibilitySemantics={presentation.accessibilitySemantics}
            title={t(presentation.titleKey)}
            {...(presentation.reasonKey ? { reason: t(presentation.reasonKey) } : {})}
            {...(decision ? { diagnosticCode: decision.blockerCode } : {})}
            {...(presentation.kind === 'loading'
                ? { secondaryAction: exitAction }
                : { action: exitAction })}
        />
    );
}
