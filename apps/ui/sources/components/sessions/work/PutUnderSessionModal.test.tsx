import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';

installDisconnectedServerSocketBoundary();
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

import { PutUnderSessionModal } from './PutUnderSessionModal';
import { PUT_UNDER_TOP_LEVEL_OPTION_ID } from './putUnderChooser';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readLockedSessionName } from '@/utils/sessions/sessionUtils';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

async function captureDisplayedChoice(screen: Awaited<ReturnType<typeof renderScreen>>, id: string) {
    return vi.waitFor(() => {
        const props = screen.root.findByType<typeof SelectionList>(SelectionList).props;
        const option = props.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(candidate => candidate.id === id);
        if (!option) throw new Error(`Expected displayed choice ${id}`);
        return { onSelect: props.onSelect, option };
    });
}

describe('PutUnderSessionModal captured scope', () => {
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let previous: ReturnType<ReturnType<typeof getStorage>['getState']>;
    const relationWrites: string[] = [];
    const sessionContentReads: string[] = [];
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        previous = getStorage().getState();
        retireActiveServerAccountScopeLifetime();
        relationWrites.length = 0;
        sessionContentReads.length = 0;
        account = await restoreServerAccountForTest({ serverUrl: 'https://put-under.test', accountId: 'account_a', request: createSessionReadBatchFetchBoundary(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account_a' });
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path.endsWith('/manager/options')) {
                const input = JSON.parse(String(init?.body)) as { candidateSessionIds: string[] };
                return Response.json({ sessionId: 'self', currentManagerSessionId: 'lead', candidates: input.candidateSessionIds.map(sessionId => ({ sessionId, allowed: true })) });
            }
            if (path.endsWith('/manager')) relationWrites.push(path);
            // Count candidate bodies (including batched snapshot/turn/message reads), not
            // the Account's independent active-list or metadata-upgrade bootstrap reads.
            const candidateRead = /^\/v[12]\/sessions\/(lead|review)(?:\/|$)/.test(path);
            if (candidateRead && (init?.method ?? 'GET') === 'GET') sessionContentReads.push(path);
            return Response.json({});
        }) });
        getStorage().setState({ profileScope: { serverId: account.home.id, accountId: 'account_a' }, sessions: {
            self: createSessionFixture({ id: 'self', serverId: account.home.id, manager: { sessionId: 'lead' } }),
            lead: createSessionFixture({ id: 'lead', serverId: account.home.id }),
        } });
    });
    afterEach(async () => { standardCleanup(); await account?.dispose(); retireActiveServerAccountScopeLifetime(); getStorage().setState(previous, true); });

    it('puts leads first and gives every candidate a quiet second line, so a long title keeps to one line', async () => {
        const state = getStorage().getState();
        getStorage().setState({ sessions: { ...state.sessions,
            peer: createSessionFixture({ id: 'peer', serverId: account.home.id, updatedAt: 90, createdAt: 1 }),
            lead: createSessionFixture({ id: 'lead', serverId: account.home.id, updatedAt: 10, createdAt: 1,
                managedSessions: { total: 2, working: 2, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null } }),
        } });
        const screen = await renderScreen(<PutUnderSessionModal sessionId="self" serverId={account.home.id} onClose={vi.fn()} />);
        await vi.waitFor(() => {
            const options = screen.root.findByType<typeof SelectionList>(SelectionList).props.rootStep.sections
                .flatMap(section => section.kind === 'static' ? section.options : []);
            expect(options.map(option => option.id)).toEqual([PUT_UNDER_TOP_LEVEL_OPTION_ID, 'lead', 'peer']);
            expect(options.find(option => option.id === 'lead')?.subtitle).toContain('sessionWork.strip.stillWorking');
            expect(options.find(option => option.id === 'peer')?.subtitle).toBeTruthy();
        });
    });

    it('uses the held sidebar identity for unopened candidates without reading Session content', async () => {
        const source = createSessionFixture({ id: 'lead', serverId: account.home.id, encryptionMode: 'e2ee',
            encryptedContentAvailability: undefined, metadata: null, active: true, presence: undefined });
        const declared = createSessionFixture({ id: 'review', serverId: account.home.id, metadataLayoutVersion: 1,
            metadata: { path: '', host: '', v: 1, agentPresentation: { agentId: 'acme.reviewer' } },
            ownerMetadataView: { name: 'Review release', path: '/repo', host: 'work' } });
        getStorage().setState({ sessions: { self: getStorage().getState().sessions.self! },
            sessionListRowsByServerId: { [account.home.id]: {
                lead: buildSessionListRenderableFromSession(source),
                review: buildSessionListRenderableFromSession(declared),
            } } });
        const screen = await renderScreen(<PutUnderSessionModal sessionId="self" serverId={account.home.id} onClose={vi.fn()} />);
        expect((await captureDisplayedChoice(screen, 'lead')).option.label).toBe(readLockedSessionName());
        const review = (await captureDisplayedChoice(screen, 'review')).option;
        expect(review.label).toBe('Review release');
        expect(React.isValidElement<{ agentId: string | null }>(review.icon) && review.icon.type === ExecutionRunAgentMark
            ? review.icon.props.agentId : null).toBe('acme.reviewer');
        expect(relationWrites).toEqual([]);
        expect(sessionContentReads).toEqual([]);
    });

    it('retires an open chooser when its Account lifetime ends', async () => {
        const onClose = vi.fn();
        await renderScreen(<PutUnderSessionModal sessionId="self" serverId={account.home.id} onClose={onClose} />);
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => {
            getStorage().setState({ profileScope: { serverId: account.home.id, accountId: 'account_b' } });
            captureActiveServerAccountScopeLifetime();
        });
        expect(onClose).toHaveBeenCalled();
        expect(relationWrites).toEqual([]);
    });

    it('refuses a captured top-level choice after the source Session leaves the current store', async () => {
        const onClose = vi.fn();
        const screen = await renderScreen(<PutUnderSessionModal sessionId="self" serverId={account.home.id} onClose={onClose} />);
        const choice = await captureDisplayedChoice(screen, PUT_UNDER_TOP_LEVEL_OPTION_ID);
        await act(async () => {
            getStorage().setState({ sessions: {} });
            choice.onSelect(choice.option.id, choice.option);
        });
        expect(onClose).toHaveBeenCalled();
        expect(relationWrites).toEqual([]);
    });

    it('rechecks current lead permissions before treating a displayed current lead as a no-op', async () => {
        const onClose = vi.fn();
        const screen = await renderScreen(<PutUnderSessionModal sessionId="self" serverId={account.home.id} onClose={onClose} />);
        await vi.waitFor(() => {
            const sections = screen.root.findByType<typeof SelectionList>(SelectionList).props.rootStep.sections;
            expect(sections.some(section => section.kind === 'static'
                && section.options.some(option => option.id === 'lead' && !option.disabled))).toBe(true);
        });
        const choice = await captureDisplayedChoice(screen, 'lead');
        await act(async () => {
            const sessions = getStorage().getState().sessions;
            const lead = sessions.lead!;
            getStorage().setState({ sessions: { ...sessions, lead: { ...lead,
                access: { ...lead.access!, capabilities: { ...lead.access!.capabilities, submitAgentInput: false } } } } });
            choice.onSelect(choice.option.id, choice.option);
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-put-under-error')).not.toBeNull();
        expect(relationWrites).toEqual([]);
    });
});
