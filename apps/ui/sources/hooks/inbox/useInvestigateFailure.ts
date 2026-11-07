import * as React from 'react';
import {
    useHealthNoticeInvestigate,
    type BoundHealthNoticeInvestigation,
} from '@/components/inbox/detail/healthNoticeInvestigation';
import { failureInvestigationSubjectKey, type FailureInvestigationSubject } from './accountNoticeInvestigation';
import { useAccountNoticeInvestigation } from './AccountNoticeInvestigationProvider';

/** Every app-shell failure surface borrows the same Account owner without mounting Inbox. */
export function useInvestigateFailure(subject: FailureInvestigationSubject | null) {
    const owner = useAccountNoticeInvestigation();
    const key = subject ? failureInvestigationSubjectKey(subject) : null;
    const investigation = React.useMemo((): BoundHealthNoticeInvestigation | null => !subject ? null : ({
        readChoices: options => owner.readChoices(subject, options),
        resume: options => owner.resume(subject, options),
        run: (selection, options) => owner.run(subject, selection, options),
    }), [owner, key]);
    return useHealthNoticeInvestigate(investigation, investigation);
}
