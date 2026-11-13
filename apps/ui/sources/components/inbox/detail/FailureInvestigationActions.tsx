import * as React from 'react';
import { View } from 'react-native';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';

import { useAccountNoticeInvestigation } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { useInvestigationSessionResult } from '@/hooks/inbox/useInvestigationSessionResult';
import { OperationsOutcomeGroup } from '@/components/workflows/run/OperationsOutcomeGroup';
import { t } from '@/text';
import { InvestigationAgentActionButtons } from './InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from './InvestigationOutcomeBanner';

/** Failure surfaces consume the Account's choices and retained Finding through the same owner. */
export function FailureInvestigationActions(props: Readonly<{
    subject: TriageFailureSubjectV1;
    serverId: string;
    controllerMachineId?: string;
    testID: string;
    compact: boolean;
    emphasis?: 'primary' | 'secondary';
}>) {
    const options = React.useMemo(() => ({ agentActions: 'withDefault' as const,
        ...(props.controllerMachineId ? { externalActionTarget: {
            kind: 'machine' as const, machineId: props.controllerMachineId,
        } } : {}),
    }), [props.controllerMachineId]);
    const investigation = useInvestigateFailure(props.subject, options);
    const owner = useAccountNoticeInvestigation();
    const persisted = useInvestigationSessionResult(owner, props.subject, investigation.outcome, options);
    const input = React.useMemo(() => persisted ? { subject: props.subject,
        finding: { kind: 'investigate' as const, ...persisted }, produced: persisted.produced,
    } : null, [persisted, props.subject]);
    return <View testID={props.testID}>
        <InvestigationAgentActionButtons actions={investigation.actions ?? [{
            label: t('inbox.work.healthNotice.investigate'), launchMode: 'review', startable: false,
        }]} pending={investigation.pending || investigation.actions === undefined} compact={props.compact} emphasis={props.emphasis}
            onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }} />
        {investigation.showOutcome && investigation.outcome ? <InvestigationOutcomeBanner
            outcome={investigation.outcome} serverId={props.serverId} testID={props.testID}
            onChoosePlacement={investigation.investigateWithPlacement} pending={investigation.pending} /> : null}
        {input ? <OperationsOutcomeGroup input={input} testID={`${props.testID}.outcome`} /> : null}
    </View>;
}
