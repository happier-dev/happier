import { readAuthoredSessionModelSelection } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';

export {
    findAssignedProviderModelCredentialBinding,
    readTeamCredentialProviderModelSelection,
    replaceProviderModelCredentialBinding,
    type AssignedProviderModelCredentialBinding,
} from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';

/** Restore the effective model reference for readers of an authored Agent selection. */
export function readAuthoredSessionModelRef(input: Parameters<typeof readAuthoredSessionModelSelection>[0]) {
    return readAuthoredSessionModelSelection(input)?.ref;
}
