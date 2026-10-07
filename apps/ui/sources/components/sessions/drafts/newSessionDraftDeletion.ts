import { SessionAuthoringExecutionTargetV2Schema, TemporaryComputerActivationRefV1Schema } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import { isNewSessionDraftLaunchInCustody } from '@/components/sessions/new/modules/newSessionDraftLaunchCustody';
import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

type Draft = Pick<NewSessionDraftProjection, 'document' | 'localSupplement'>;

export function resolveRunnerDraftActivation(input: Pick<Draft, 'document'>): Readonly<{
    isTemporaryComputer: boolean;
    publicRef: ReturnType<typeof TemporaryComputerActivationRefV1Schema.parse> | null;
}> {
    const document = input.document;
    if (document.v !== 2 || document.target.kind !== 'newSession') {
        return { isTemporaryComputer: false, publicRef: null };
    }
    const targetResult = SessionAuthoringExecutionTargetV2Schema.nullable().safeParse(document.target.authoring.executionTarget?.value ?? null);
    const referenceResult = TemporaryComputerActivationRefV1Schema.nullable().safeParse(document.target.authoring.temporaryComputerActivationRef?.value ?? null);
    const publicRef = referenceResult.success ? referenceResult.data : null;
    return { isTemporaryComputer: (targetResult.success && targetResult.data?.kind === 'temporary_computer') || publicRef !== null, publicRef };
}

export function isNewSessionDraftDeletionBlocked(input: Readonly<{
    draft: Draft;
    accountId: string;
    operations: Parameters<typeof isNewSessionDraftLaunchInCustody>[0]['operations'];
}>): boolean {
    // The draft tombstone atomically closes temporary-computer activation.
    if (resolveRunnerDraftActivation(input.draft).isTemporaryComputer) return false;
    return isNewSessionDraftLaunchInCustody({ accountId: input.accountId,
        launchUserAttemptId: input.draft.localSupplement.launchUserAttemptId, operations: input.operations });
}
