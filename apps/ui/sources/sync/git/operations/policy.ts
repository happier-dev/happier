import { evaluateScmOperationPreflight, type ScmOperationPreflightResult } from '@/scm/core/operationPolicy';

type ScmPreflightInput = Parameters<typeof evaluateScmOperationPreflight>[0];

export type GitOperationPreflightResult = ScmOperationPreflightResult;

export function evaluateGitOperationPreflight(input: {
    intent: ScmPreflightInput['intent'];
    gitWriteEnabled: boolean;
    sessionPath: string | null;
    snapshot: ScmPreflightInput['snapshot'];
    commitStrategy?: ScmPreflightInput['commitStrategy'];
    commitSelectionPaths?: ScmPreflightInput['commitSelectionPaths'];
}): GitOperationPreflightResult {
    return evaluateScmOperationPreflight({
        intent: input.intent,
        scmWriteEnabled: input.gitWriteEnabled,
        sessionPath: input.sessionPath,
        snapshot: input.snapshot,
        commitStrategy: input.commitStrategy,
        commitSelectionPaths: input.commitSelectionPaths,
    });
}

