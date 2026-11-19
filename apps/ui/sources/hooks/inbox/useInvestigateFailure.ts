import * as React from 'react';
import {
    useHealthNoticeInvestigate,
    useInvestigationAgentActions,
    type BoundHealthNoticeInvestigation,
} from '@/components/inbox/detail/healthNoticeInvestigation';
import { failureInvestigationSubjectKey, type FailureInvestigationSubject,
    type FailureInvestigationExecutionOptions } from './accountNoticeInvestigation';
import { useAccountNoticeInvestigation } from './AccountNoticeInvestigationProvider';
import { useMachinePresenceSummaries, type MachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

const MACHINE_UNREACHABLE = { kind: 'unavailable', code: 'machine_unreachable' } as const;
const sameReachability = (left: readonly MachinePresenceSummary[], right: readonly MachinePresenceSummary[]) =>
    left[0]?.reachability === right[0]?.reachability;

export type InvestigateFailureOptions = Readonly<{
    /** Read the page's records for its agent-action buttons: the task default and this subject's own, or only its own. */
    agentActions?: 'withDefault' | 'subjectOnly';
    externalActionTarget?: FailureInvestigationExecutionOptions['externalActionTarget'];
}>;

/** Every app-shell failure surface borrows the same Account owner without mounting Inbox. */
export function useInvestigateFailure(subject: FailureInvestigationSubject | null, options?: InvestigateFailureOptions) {
    const owner = useAccountNoticeInvestigation();
    const key = subject ? failureInvestigationSubjectKey(subject) : null;
    const externalActionTarget = options?.externalActionTarget;
    const catalogMachineId = options?.agentActions && externalActionTarget?.kind === 'machine'
        && subject && owner.isEligible(subject) ? externalActionTarget.machineId : null;
    const [catalogMachine] = useMachinePresenceSummaries(owner.scope?.serverId,
        catalogMachineId ? [catalogMachineId] : [], undefined, sameReachability);
    const investigation = React.useMemo((): BoundHealthNoticeInvestigation | null => !subject ? null : ({
        readAgentActions: (includeDefault, options) => owner.readAgentActions(subject, includeDefault, { ...options, externalActionTarget }),
        launch: (intent, options) => owner.launch(subject, intent, { ...options, externalActionTarget }),
    }), [owner, key, externalActionTarget]);
    return useBoundFailureInvestigation(investigation, options, catalogMachine?.reachability === 'unreachable');
}

/** Native failures and Inbox's already-bound notice share the same launch and recovery flow. */
export function useBoundFailureInvestigation(investigation: BoundHealthNoticeInvestigation | null, options?: InvestigateFailureOptions,
    catalogMachineUnreachable = false) {
    const intent = useHealthNoticeInvestigate(investigation, investigation);
    const [catalogAttempt, setCatalogAttempt] = React.useState(0);
    // Pushed reachability can settle the controls before a contributed Action can be acquired.
    const answer = useInvestigationAgentActions(options?.agentActions && !catalogMachineUnreachable ? investigation : null,
        { includeDefault: options?.agentActions === 'withDefault', attempt: catalogAttempt });
    const catalog = catalogMachineUnreachable ? MACHINE_UNREACHABLE : answer;
    const catalogRefused = catalog != null && 'kind' in catalog;
    const actions = catalogRefused ? null : catalog;
    // A refused catalog read is the controls' availability (InvestigationAgentActionButtons `unavailable`, or the
    // page's default record standing pressable); only a launch the person pressed has an outcome banner
    // (PAGE-ACCEPT-176 R3-D1: nothing was pressed, so nothing "failed").
    const catalogOutcome = catalogRefused ? catalog : null;
    const retryCatalog = React.useCallback(() => { setCatalogAttempt(value => value + 1); }, []);
    const outcome = intent.outcome;
    const placementUnresolved = intent.outcome?.kind === 'placement_choice_required';
    const { launch } = intent;
    // Once only: if the composer itself still asks for a placement, its own chooser stays as the way forward.
    const openedComposerForPlacement = React.useRef(false);
    React.useEffect(() => { openedComposerForPlacement.current = false; }, [investigation]);
    React.useEffect(() => {
        if (!placementUnresolved || openedComposerForPlacement.current) return;
        openedComposerForPlacement.current = true;
        void launch('review');
    }, [placementUnresolved, launch]);
    const showOutcome = outcome !== null
        && (!placementUnresolved || openedComposerForPlacement.current && !intent.pending);
    return { ...intent, actions, catalogOutcome,
        retryCatalog: catalogMachineUnreachable ? undefined : retryCatalog, outcome, showOutcome };
}
