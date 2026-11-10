import * as React from 'react';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';

import { InvestigationAgentActionButtons, type InvestigationAgentActionButtonModel } from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

export type WorkflowRunInvestigationSubject = Extract<TriageFailureSubjectV1, { kind: 'workflowRun' }>;

/** Run failures borrow the Account's configured handoff and its shared controls. */
export function WorkflowRunFailureAgentActions(props: Readonly<{
    subject: WorkflowRunInvestigationSubject;
    testIDPrefix: string;
}>) {
    const investigation = useInvestigateFailure(props.subject, { agentActions: 'withDefault' });
    const compact = useDeviceType() === 'phone';
    const fallback: readonly InvestigationAgentActionButtonModel[] = [{
        label: t('inbox.work.healthNotice.investigate'),
        launchMode: 'review',
        startable: true,
    }];
    return <>
        <InvestigationAgentActionButtons
            actions={investigation.actions ?? fallback}
            pending={investigation.pending}
            compact={compact}
            onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }}
        />
        {investigation.showOutcome && investigation.outcome ? <InvestigationOutcomeBanner
            outcome={investigation.outcome}
            serverId={props.subject.serverId}
            testID={`${props.testIDPrefix}-investigate`}
            pending={investigation.pending}
            onChoosePlacement={investigation.investigateWithPlacement}
        /> : null}
    </>;
}
