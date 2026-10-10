import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Modal } from '@/modal';
import { leaveTeam } from '@/sync/ops/teams/teamMemberOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { teamMutationFailureLabel } from '../teamMutationPresentation';

/** One confirmation and approval continuation for the two self-removal entry points. */
export const TeamLeaveAction = React.memo(function TeamLeaveAction(props: Readonly<{
    context: TeamSectionContext;
    testID: string;
    presentation?: 'row' | 'button';
}>) {
    const { context } = props;
    const router = useRouter();
    const [busy, setBusy] = React.useState(false);
    const inFlight = React.useRef(false);
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const leave = React.useCallback(async () => {
        if (inFlight.current || !context.mutationsAvailable || context.approvalPending) return;
        inFlight.current = true;
        const finish = () => { if (mounted.current) router.replace('/settings/teams'); };
        const failure = (message: string) => { if (mounted.current) Modal.alert(t('homeGovernance.changeFailedTitle'), message); };
        try {
            const confirmed = await Modal.confirm(
                t('teams.leave.confirmTitle', { name: context.team.name }),
                t('teams.leave.confirmBody'),
                { confirmText: t('teams.leave.action'), destructive: true },
            );
            if (!confirmed || !mounted.current) return;
            setBusy(true);
            const outcome = await leaveTeam({
                scope: context.scope,
                address: context.address,
                onSucceeded: finish,
                onApprovalFailed: (code) => failure(teamMutationFailureLabel({ kind: 'forbidden', code, retryable: false })),
            });
            if (outcome.kind === 'failed') failure(teamMutationFailureLabel(outcome.failure));
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
            else failure(t('teams.errors.generic'));
        } finally {
            inFlight.current = false;
            if (mounted.current) setBusy(false);
        }
    }, [context, router]);

    if (!context.team.capabilities.leave) return null;
    const button = <RoundButton
        testID={props.testID}
        size="small"
        display="destructive"
        title={t('teams.leave.action')}
        titleNumberOfLines="complete"
        loading={busy}
        disabled={busy || !context.mutationsAvailable || context.approvalPending}
        onPress={(event) => { event?.stopPropagation(); void leave(); }}
    />;
    return props.presentation === 'button' ? button : (
        <ItemGroup surface="none">
            <SectionButtonRow footnote={t('teams.leave.description')} trailing={button}>
                {null}
            </SectionButtonRow>
        </ItemGroup>
    );
});
