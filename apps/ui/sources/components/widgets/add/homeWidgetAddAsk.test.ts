import { afterEach, describe, expect, it, vi } from 'vitest';

import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { buildHomeWidgetAddAsk } from './HomeWidgetAddPopover';

afterEach(() => { resetSessionDraftRepositoryForTests(); });

/** Add to Home's no-result Ask (lab `widget-add` wsplit A4/A4p): Home has no Session, so it drafts a new one. */
describe('Ask the agent from Add to Home', () => {
    it('drafts the request into a new Session through the New Session seed owner and sends nothing', () => {
        const scope = { serverId: 'home', accountId: 'me' };
        const draftId = '00000000-0000-4000-8000-0000000000a4';
        const navigate = vi.fn((_request: unknown) => readNewSessionDraftFromRepository({ scope, draftId }));
        const ask = buildHomeWidgetAddAsk({ scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: navigate });
        expect(ask.draft.length).toBeGreaterThan(0);
        expect(navigate).not.toHaveBeenCalled();
        ask.onPick();
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(navigate.mock.calls[0]![0]).toMatchObject({ draftId });
        const opened = navigate.mock.results[0];
        expect(opened?.type === 'return' ? opened.value?.input : undefined).toBe(ask.draft);
    });
});
