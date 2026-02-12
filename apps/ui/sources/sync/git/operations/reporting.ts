import {
    reportSessionScmOperation,
    trackBlockedScmOperation,
    type ScmOperationTracker,
} from '@/scm/operations/reporting';

export type GitOperationTracker = ScmOperationTracker;

export function trackBlockedGitOperation(input: Parameters<typeof trackBlockedScmOperation>[0]) {
    return trackBlockedScmOperation(input);
}

export function reportSessionGitOperation(input: Parameters<typeof reportSessionScmOperation>[0]) {
    return reportSessionScmOperation(input);
}

