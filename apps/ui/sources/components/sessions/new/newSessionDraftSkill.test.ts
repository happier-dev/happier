import { afterEach, expect, it } from 'vitest';
import { seedNewSessionDraftV1 } from './newSessionDraftSeed';
import { includeSkillInNewSessionDraft } from './newSessionDraftSkill';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { readNewSessionDraftFromRepository, writeNewSessionAuthoringDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { createNewSessionComposerDocumentOwner } from '@/components/sessions/composer/newSessionComposerDocumentOwner';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

afterEach(() => resetSessionDraftRepositoryForTests());

it('includes an explicitly disabled library skill without changing the composer prompt', async () => {
    const scope = { serverId: 'server-a', accountId: 'account-a' };
    const draftId = '00000000-0000-4000-8000-000000000073';
    seedNewSessionDraftV1({ scope, createDraftId: () => draftId,
        seed: { prompt: { text: 'A capybara in a yellow hat', mode: 'replace' } } });
    const initial = readNewSessionDraftFromRepository({ scope, draftId });
    if (!initial) throw new Error('Expected the seeded draft');
    writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...initial,
        capabilitySelection: setSessionCapabilitySelectionItemV1({}, 'skill', 'happier:hatch-pet', 'off') } });
    await includeSkillInNewSessionDraft({ scope, draftId, skillId: 'happier:hatch-pet' });
    const draft = readNewSessionDraftFromRepository({ scope, draftId });
    expect(draft?.capabilitySelection?.skills?.forceIncludeSkillIds).toContain('happier:hatch-pet');
    const owner = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', instanceId: draftId } });
    const document = owner.read().document;
    expect(document.structuredInputMentions).toEqual([]);
    expect(document.text).toBe('A capybara in a yellow hat');
    expect(readNewSessionDraftFromRepository({ scope: { ...scope, accountId: 'another' }, draftId })).toBeNull();
});
