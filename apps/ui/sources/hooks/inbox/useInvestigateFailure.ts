import * as React from 'react';
import {
    useHealthNoticeInvestigate,
    useInvestigationAgentActions,
    type BoundHealthNoticeInvestigation,
} from '@/components/inbox/detail/healthNoticeInvestigation';
import { failureInvestigationSubjectKey, type FailureInvestigationSubject } from './accountNoticeInvestigation';
import { useAccountNoticeInvestigation } from './AccountNoticeInvestigationProvider';

export type InvestigateFailureOptions = Readonly<{
    /** Read the page's records for its agent-action buttons: the task default and this subject's own, or only its own. */
    agentActions?: 'withDefault' | 'subjectOnly';
}>;

/** Every app-shell failure surface borrows the same Account owner without mounting Inbox. */
export function useInvestigateFailure(subject: FailureInvestigationSubject | null, options?: InvestigateFailureOptions) {
    const owner = useAccountNoticeInvestigation();
    const key = subject ? failureInvestigationSubjectKey(subject) : null;
    const investigation = React.useMemo((): BoundHealthNoticeInvestigation | null => !subject ? null : ({
        readChoices: options => owner.readChoices(subject, options),
        resume: options => owner.resume(subject, options),
        run: (selection, options) => owner.run(subject, selection, options),
    }), [owner, key]);
    return useBoundFailureInvestigation(investigation, options);
}

/** Native failures and Inbox's already-bound notice share the same launch and recovery flow. */
export function useBoundFailureInvestigation(investigation: BoundHealthNoticeInvestigation | null, options?: InvestigateFailureOptions) {
    const intent = useHealthNoticeInvestigate(investigation, investigation);
    const actions = useInvestigationAgentActions(options?.agentActions ? investigation : null,
        { includeDefault: options?.agentActions === 'withDefault' });
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
    const showOutcome = intent.outcome !== null
        && (!placementUnresolved || openedComposerForPlacement.current && !intent.pending);
    return { ...intent, actions, showOutcome };
}
