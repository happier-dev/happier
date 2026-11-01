import * as React from 'react';

import { ServiceOutputDisclosure } from '@/components/sessions/localServices/ServiceOutputDisclosure';
import { useLocalServiceEntryActions } from '@/components/sessions/localServices/useLocalServiceEntryActions';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import type { BrowserFrameRecovery } from './types';

type BrowserFrameUnavailableProps = Readonly<{
    testID: string;
    reasonCode?: string;
    /**
     * R-3: the system-browser escape. Whenever the caller still knows a URL the user asked for, an
     * unavailable in-app engine must offer to open it in their own browser rather than dead-end.
     * Fulfilled by the caller through the canonical `buildOpenExternalTabSelection` →
     * `openBrowserExternalTabSelection` path, so this card never learns how an OS tab is opened.
     */
    onOpenInSystemBrowser?: () => void;
    /**
     * What a relay preview's card offers (lab ST). Ended: say what ended, name the last page, offer
     * Open again while its Service runs (or the way to Services once nothing runs it), and Close tab
     * beside it. Can't reach: Try again (lab ST, Unavailable). The escape above wins when both exist.
     */
    recovery?: BrowserFrameRecovery;
}>;

export function BrowserFrameUnavailable(props: BrowserFrameUnavailableProps): React.ReactElement {
    const startAgain = props.reasonCode === 'preview_ended' ? props.recovery?.startAgain : undefined;
    // Only a card that offers Start (a failed start, or a stopped Service beside Services) binds the
    // Services Start Action; every other card stays hook-free.
    return startAgain ? <BrowserFrameStartAgain {...props} startAgain={startAgain} /> : <BrowserFrameUnavailableCard {...props} />;
}

/** The failed Service's Start, bound to the same Action admission the Services row uses. */
function BrowserFrameStartAgain(props: BrowserFrameUnavailableProps & Readonly<{
    startAgain: NonNullable<BrowserFrameRecovery['startAgain']>;
}>): React.ReactElement {
    const { target, serverId, run } = props.startAgain;
    const { handlers, review } = useLocalServiceEntryActions({
        machineId: target.machineId ?? null,
        serverId,
        sessionId: target.sessionId,
        scope: 'workspace',
        testID: `${props.testID}-start-again`,
    });
    const start = handlers.onStartLauncherTarget;
    const onStartAgain = React.useMemo(() => start ? () => { void run(async () => start(target)); } : undefined, [run, start, target]);
    return <>
        <BrowserFrameUnavailableCard {...props} onStartAgain={onStartAgain} />
        {review}
    </>;
}

function BrowserFrameUnavailableCard(props: BrowserFrameUnavailableProps & Readonly<{
    onStartAgain?: () => void;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'browserFrame' });
    const ended = props.reasonCode === 'preview_ended' ? props.recovery : undefined;
    const unreachable = props.reasonCode === 'preview_transport_unavailable' ? props.recovery : undefined;
    const onTryAgain = unreachable?.onTryAgain;
    // The Machine that isn't answering, by name (lab ST, Unavailable); unknown keeps the unnamed sentence.
    const unreachableMachineName = unreachable?.machineName?.trim() || null;
    const lastPage = ended?.lastPage?.trim() || null;
    const onOpenAgain = ended?.onOpenAgain;
    const stoppedServiceName = ended?.stoppedServiceName?.trim() || null;
    // The ended preview's Service by name wherever the copy would otherwise say "its service".
    const serviceName = ended?.serviceName?.trim() || null;
    // A failed start's own output is the recovery: it says why, where Go to Services only says where.
    const startFailureOutput = ended?.serviceStartFailure?.recovery ?? null;
    const onOpenServices = startFailureOutput ? undefined : ended?.onOpenServices;
    const onClose = ended?.onClose;
    // A refused Open again says why in place of "its service is running", and keeps saying it once the
    // Service is known to have stopped and Open again has gone with it. A retry stays usable beside
    // its refusal; the presence of an action does not establish that reopening succeeded.
    const openAgainFailure = ended?.serviceStartFailure?.body
        ?? (ended?.openAgainFailure?.trim() || null);
    // One sentence for the consequence: Open again here, the stopped Service by name, or the hedge (with the way to
    // Services when the card does not offer it). The last page is its own quiet line, never folded into it.
    const consequence = onOpenAgain
        ? serviceName ? t('browserShell.unavailable.previewEndedRunningNamed', { service: serviceName })
            : t('browserShell.unavailable.previewEndedRunning')
        : stoppedServiceName ? t('browserShell.unavailable.previewEndedServiceStopped', { service: stoppedServiceName })
        : onOpenServices
            ? serviceName ? t('browserShell.unavailable.previewEndedStoppedNamed', { service: serviceName })
                : t('browserShell.unavailable.previewEndedStopped')
            : serviceName ? t('browserShell.unavailable.previewEndedNamed', { service: serviceName }) : copy.body;
    const reason = !props.reasonCode ? undefined
        : !ended ? unreachableMachineName ? t('browserShell.unavailable.previewTransportUnavailableNamed', { machine: unreachableMachineName }) : copy.body
            : openAgainFailure ?? consequence;
    const detail = ended && lastPage ? t('browserShell.unavailable.previewEndedLastPageDetail', { page: lastPage }) : undefined;
    const closeAction: SurfaceStateAction | undefined = onClose ? {
        label: t('browserShell.unavailable.closeTab'),
        onPress: onClose,
        testID: `${props.testID}-ended-close`,
    } : undefined;
    // Start again, Open again and Go to Services continue the person's work, so they lead filled (lab ST, Ended);
    // Try again retries a failure and stays the quieter recovery (lab ST, Unavailable).
    const action: SurfaceStateAction | undefined = props.onOpenInSystemBrowser ? {
        label: t('browserShell.nonFramable.openInSystemBrowser'),
        onPress: props.onOpenInSystemBrowser,
    } : props.onStartAgain ? {
        // A failed start is started again; a stopped Service is started by name ("Start Lumen web").
        label: !ended?.serviceStartFailure && stoppedServiceName
            ? t('browserShell.unavailable.startService', { service: stoppedServiceName })
            : t('browserShell.unavailable.startAgain'),
        onPress: props.onStartAgain,
        testID: `${props.testID}-ended-start-again`,
        invitation: true,
    } : onOpenAgain ? {
        label: t('browserShell.unavailable.openAgain'),
        onPress: onOpenAgain,
        testID: `${props.testID}-ended-open-again`,
        invitation: true,
    } : onOpenServices ? {
        label: t('browserShell.unavailable.openServices'),
        onPress: onOpenServices,
        testID: `${props.testID}-ended-services`,
        invitation: true,
    } : onTryAgain ? {
        label: t('common.retry'),
        onPress: onTryAgain,
        testID: `${props.testID}-try-again`,
    } : closeAction;
    return (
        <SurfaceStateCard
            testID={`${props.testID}-unavailable`}
            kind="unavailable"
            // An ended preview shows the closed page (the Browser's ended glyph, as the agent browser's Ended
            // card); Can't reach keeps the unreachable glyph, so the two never read as the same state.
            iconName={ended ? 'browsers' : undefined}
            title={ended?.serviceStartFailure?.title ?? copy.title}
            reason={reason}
            {...(detail ? { detail } : {})}
            diagnosticCode={ended?.serviceStartFailure?.reasonCode ?? copy.diagnosticCode}
            action={action}
            secondaryAction={action !== closeAction ? closeAction : undefined}
            body={startFailureOutput
                ? <ServiceOutputDisclosure output={startFailureOutput} align="center" testID={props.testID} />
                : undefined}
        />
    );
}
