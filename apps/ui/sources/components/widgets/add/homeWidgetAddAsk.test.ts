import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { buildHomeWidgetAddAsk } from './HomeWidgetAddPopover';

import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries({ ...homes, request: createSessionReadBatchFetchBoundary(homes.request) });
let scope = { serverId: '', accountId: 'account-a' };
beforeEach(async () => {
    await homes.reset();
    scope = { serverId: await homes.addHome({ name: 'Authoring', serverUrl: 'https://continuation.test', accountId: 'account-a', currentAccount: true }), accountId: 'account-a' };
    publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://continuation.test', generation: 1 });
    storage.getState().activateProfileScope(scope);
});
afterEach(async () => { resetSessionDraftRepositoryForTests(); publishAppliedActiveServerRuntimeAvailability(false); await homes.reset(); });
/** Add to Home's no-result Ask (lab `widget-add` wsplit A4/A4p): Home has no Session, so it drafts a new one. */
describe('Ask the agent from Add to Home', () => {
    it('drafts the request into a new Session through the New Session seed owner and sends nothing', async () => {
        const draftId = '00000000-0000-4000-8000-0000000000a4';
        const navigate = vi.fn((_request: unknown) => readNewSessionDraftFromRepository({ scope, draftId }));
        const ask = buildHomeWidgetAddAsk({ scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: navigate });
        expect(ask.draft.length).toBeGreaterThan(0);
        expect(navigate).not.toHaveBeenCalled();
        await ask.onPick();
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(navigate.mock.calls[0]![0]).toMatchObject({ draftId });
        const opened = navigate.mock.results[0];
        expect(opened?.type === 'return' ? opened.value?.input : undefined).toBe(ask.draft);
    });
});
