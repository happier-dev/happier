import * as React from 'react';
import { View } from 'react-native';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';

import { InvestigationAgentActionButtons, type InvestigationAgentActionButtonModel } from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { workflowRunStyles as styles } from './workflowRunStyles';

export type WorkflowRunInvestigationSubject = Extract<TriageFailureSubjectV1, { kind: 'workflowRun' }>;

/** Run failures borrow the Account's configured handoff and its shared controls. */
export function WorkflowRunFailureAgentActions(props: Readonly<{
    subject: WorkflowRunInvestigationSubject;
    testIDPrefix: string;
    /** Whether Investigate leads its card or the card's recovery action does (one filled action per card). */
    emphasis?: 'primary' | 'secondary';
    /**
     * The card's other recovery actions, drawn in the same row at their own widths: before Investigate when one of
     * them leads, after it when Investigate leads.
     */
    actions?: React.ReactNode;
}>) {
    // A Run's own Investigate ("Investigate this Run") stands for the Account's task default on this page, so the page
    // offers Investigate once (DESIGN-ACCEPT-7 NF-10); with no Run action of its own, the default launches.
    const investigation = useInvestigateFailure(props.subject, { agentActions: 'subjectOnly' });
    const compact = useDeviceType() === 'phone';
    const fallback: readonly InvestigationAgentActionButtonModel[] = [{
        label: t('inbox.work.healthNotice.investigate'),
        launchMode: 'review',
        startable: true,
    }];
    const investigate = (
        <InvestigationAgentActionButtons
            actions={investigation.actions?.length ? investigation.actions : fallback}
            pending={investigation.pending}
            compact={compact}
            {...(props.emphasis === undefined ? {} : { emphasis: props.emphasis })}
            onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }}
        />
    );
    const leads = props.emphasis !== 'secondary';
    return <>
        {props.actions == null ? investigate : (
            <View style={styles.actions}>
                {leads ? investigate : props.actions}
                {leads ? props.actions : investigate}
            </View>
        )}
        {investigation.showOutcome && investigation.outcome ? <InvestigationOutcomeBanner
            outcome={investigation.outcome}
            serverId={props.subject.serverId}
            testID={`${props.testIDPrefix}-investigate`}
            pending={investigation.pending}
            onChoosePlacement={investigation.investigateWithPlacement}
        /> : null}
    </>;
}
