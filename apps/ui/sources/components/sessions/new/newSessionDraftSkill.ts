import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { readNewSessionDraftFromRepository, writeNewSessionAuthoringDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';

/** Includes a library skill through the ordinary Session capabilities owner, leaving the editor empty. */
export function includeSkillInNewSessionDraft(input: Readonly<{
    scope: ServerAccountScope; draftId: string; skillId: string;
}>): NewSessionDraft {
    const draft = readNewSessionDraftFromRepository(input);
    if (!draft) throw new Error('Cannot include a skill on an unavailable draft');
    const included = { ...draft,
        capabilitySelection: setSessionCapabilitySelectionItemV1(draft.capabilitySelection ?? {}, 'skill', input.skillId, 'on') };
    writeNewSessionAuthoringDraftToRepository({ ...input, draft: included });
    return included;
}
