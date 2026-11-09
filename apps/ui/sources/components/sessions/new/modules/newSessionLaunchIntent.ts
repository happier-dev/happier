import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { managedMachineCreationIntent } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ComposerDraftDocument } from '@/components/sessions/composer/composerDocumentOwner';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import type { SessionSpawnSourceContextV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnSourceContextV1';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { SessionSpaceMembershipTargetV1 } from '@happier-dev/protocol/actions';

/** The launch owner's materialization of the Instructions the user already authored. */
export type NewSessionPreparedInstructions = Pick<SessionAuthoringDraft, 'instructionsDraft' | 'promptStack'>;

export function buildNewSessionLaunchIntentSignature(input: Readonly<{
    draft: SessionAuthoringDraft;
    composerDocument: ComposerDraftDocument;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    machineId: string | null;
    managedMachineSelection: ReturnType<typeof managedMachineCreationIntent>;
    sourceContext: SessionSpawnSourceContextV1 | null | undefined;
    selectedSecretReferences: SecretChoiceByProfileIdByEnvVarName;
    targetServerId: string | null;
    spaceMembership?: SessionSpaceMembershipTargetV1 | null;
}>): string {
    // These are projections/custody, not authored choices. Team source intent
    // lives in connectedServices and selectedTeamCredentialModel; availability
    // may withdraw its derived binding after Send has already admitted it.
    const { prompt: _prompt, displayText: _displayText, teamCredentialBindings: _bindings, ...draft } = input.draft;
    return stableJsonStringify({ ...input, draft });
}
