import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';
import { PENDING_INPUT_PROTOCOL_VERSION_V5 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

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
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
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
    const notes: unknown[] = [];
    let conflict: boolean;
    let settleManager: Promise<void> | undefined;
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        previous = getStorage().getState();
        retireActiveServerAccountScopeLifetime();
        relationWrites.length = 0;
        sessionContentReads.length = 0;
        notes.length = 0;
        conflict = false;
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'session.manager.set': ['ui'],
        } });
        settleManager = undefined;
        account = await restoreServerAccountForTest({ serverUrl: 'https://put-under.test', accountId: 'account_a', request: createSessionReadBatchFetchBoundary(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 });
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                const features = createRootLayoutFeaturesResponse();
                features.capabilities.session.pendingInput = { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V5 };
                return Response.json(features);
            }
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account_a' });
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path.endsWith('/manager/options')) {
                const input = JSON.parse(String(init?.body)) as { candidateSessionIds: string[] };
                return Response.json({ sessionId: 'worker', currentManagerSessionId: 'lead', candidates: input.candidateSessionIds.map(sessionId => ({ sessionId, allowed: true })) });
            }
            if (path === '/v1/sessions/worker/manager') {
                relationWrites.push(path);
                await settleManager;
                if (conflict) return Response.json({ ok: false, error: 'manager_cas_conflict' }, { status: 409 });
                const input = JSON.parse(String(init?.body));
                return Response.json({ ok: true, sessionId: 'worker', managerSessionId: input.managerSessionId,
                    attachedAt: input.managerSessionId ? 1 : null });
            }
            if (path === '/v2/sessions/next-lead/pending' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body));
                notes.push(body.content);
                return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId }, didWrite: true });
            }
            if (path === '/v2/sessions/worker' || path === '/v2/sessions/next-lead') {
                const stored = getStorage().getState().sessions[path.split('/').at(-1)!];
                if (stored) return Response.json(createPlainSessionByIdResponseFixture(stored));
            }
            // Count candidate bodies (including batched snapshot/turn/message reads), not
            // the Account's independent active-list or metadata-upgrade bootstrap reads.
            const candidateRead = /^\/v[12]\/sessions\/(lead|review)(?:\/|$)/.test(path);
            if (candidateRead && (init?.method ?? 'GET') === 'GET') sessionContentReads.push(path);
            return Response.json({});
        }) });
        getStorage().setState({ profileScope: { serverId: account.home.id, accountId: 'account_a' }, sessions: {
            worker: createSessionFixture({ id: 'worker', serverId: account.home.id, manager: { sessionId: 'lead' } }),
            lead: createSessionFixture({ id: 'lead', serverId: account.home.id }),
        } });
        const state = getStorage().getState();
        if (!state.settingsScope) throw new Error('Expected the picker Home settings scope');
        state.applySettingsForScope(state.settingsScope, { ...state.settings, actionsSettingsV1 }, 2);
    });
    afterEach(async () => { standardCleanup(); await account?.dispose(); retireActiveServerAccountScopeLifetime(); getStorage().setState(previous, true); });

    it('keeps Top level first, then offers Bots before leads and ordinary Sessions', async () => {
        const state = getStorage().getState();
        getStorage().setState({ sessions: { ...state.sessions,
            peer: createSessionFixture({ id: 'peer', serverId: account.home.id, updatedAt: 90, createdAt: 1 }),
            bot: createSessionFixture({ id: 'bot', serverId: account.home.id, updatedAt: 2, createdAt: 1,
                metadata: { host: 'work', path: '/repo', bot: { kind: 'bot' } } }),
            lead: createSessionFixture({ id: 'lead', serverId: account.home.id, updatedAt: 10, createdAt: 1,
                managedSessions: { total: 2, working: 2, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null } }),
        } });
        const screen = await renderScreen(<PutUnderSessionModal sessionId="worker" serverId={account.home.id} onClose={vi.fn()} />);
        await vi.waitFor(() => {
            const options = screen.root.findByType<typeof SelectionList>(SelectionList).props.rootStep.sections
                .flatMap(section => section.kind === 'static' ? section.options : []);
            expect(options.map(option => option.id)).toEqual([PUT_UNDER_TOP_LEVEL_OPTION_ID, 'bot', 'lead', 'peer']);
            expect(options.find(option => option.id === 'lead')?.subtitle).toContain('sessionWork.strip.stillWorking');
            expect(options.find(option => option.id === 'peer')?.subtitle).toBeTruthy();
        });
        expect(screen.findByTestId('session-put-under-note')).not.toBeNull();
    });

    it('uses the held sidebar identity for unopened candidates without reading Session content', async () => {
        const source = createSessionFixture({ id: 'lead', serverId: account.home.id, encryptionMode: 'e2ee',
            encryptedContentAvailability: undefined, metadata: null, active: true, presence: undefined });
        const declared = createSessionFixture({ id: 'review', serverId: account.home.id, metadataLayoutVersion: 1,
            metadata: { path: '', host: '', v: 1, agentPresentation: { agentId: 'acme.reviewer' } },
            ownerMetadataView: { name: 'Review release', path: '/repo', host: 'work' } });
        getStorage().setState({ sessions: { worker: getStorage().getState().sessions.worker! },
            sessionListRowsByServerId: { [account.home.id]: {
                lead: buildSessionListRenderableFromSession(source),
                review: buildSessionListRenderableFromSession(declared),
            } } });
        const screen = await renderScreen(<PutUnderSessionModal sessionId="worker" serverId={account.home.id} onClose={vi.fn()} />);
        expect((await captureDisplayedChoice(screen, 'lead')).option.label).toBe(readLockedSessionName());
        const review = (await captureDisplayedChoice(screen, 'review')).option;
        expect(review.label).toBe('Review release');
        expect(React.isValidElement<{ agentId: string | null }>(review.icon) && review.icon.type === SessionAgentCatalogIdentityIcon
            ? review.icon.props.agentId : null).toBe('acme.reviewer');
        expect(relationWrites).toEqual([]);
        expect(sessionContentReads).toEqual([]);
    });

    it('retires an open chooser when its Account lifetime ends', async () => {
        const onClose = vi.fn();
        await renderScreen(<PutUnderSessionModal sessionId="worker" serverId={account.home.id} onClose={onClose} />);
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => {
            getStorage().setState({ profileScope: { serverId: account.home.id, accountId: 'account_b' } });
            captureActiveServerAccountScopeLifetime();
        });
        expect(onClose).toHaveBeenCalled();
        expect(relationWrites).toEqual([]);
    });

    it.each([
        { note: 'Please review the patch', conflict: false, sends: true },
        { note: '  ', conflict: false, sends: false },
        { note: 'Please review the patch', conflict: true, sends: false },
    ])('sends a typed note only after a successful relation change ($note, conflict=$conflict)', async (scenario) => {
        conflict = scenario.conflict;
        const relation = Promise.withResolvers<void>();
        settleManager = relation.promise;
        const state = getStorage().getState();
        getStorage().setState({ sessions: { ...state.sessions,
            'next-lead': createSessionFixture({ id: 'next-lead', serverId: account.home.id, accessLevel: 'edit' }),
        } });
        const onClose = vi.fn();
        const screen = await renderScreen(<PutUnderSessionModal sessionId="worker" serverId={account.home.id} onClose={onClose} />);
        expect((await captureDisplayedChoice(screen, 'next-lead')).option.disabled).toBe(false);
        const field = screen.findByTestId('session-put-under-note');
        expect(field).not.toBeNull();
        await act(async () => field!.props.onChangeText(scenario.note));
        await screen.pressByTestIdAsync('session-put-under-option-next-lead');
        try {
            await vi.waitFor(() => expect(relationWrites, screen.getTextContent()).toHaveLength(1));
            expect((await captureDisplayedChoice(screen, 'next-lead')).option.loading).toBe(true);
            expect(notes).toEqual([]);
        } finally {
            relation.resolve();
        }
        if (scenario.conflict) {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('sessionWork.putUnder.errors.changed'));
            expect(onClose).not.toHaveBeenCalled();
        } else {
            await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        }
        expect(notes).toEqual(scenario.sends ? [expect.objectContaining({ t: 'plain',
            v: expect.objectContaining({ content: { type: 'text', text: scenario.note } }),
        })] : []);
    });

    it('refuses a captured top-level choice after the source Session leaves the current store', async () => {
        const onClose = vi.fn();
        const screen = await renderScreen(<PutUnderSessionModal sessionId="worker" serverId={account.home.id} onClose={onClose} />);
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
        const screen = await renderScreen(<PutUnderSessionModal sessionId="worker" serverId={account.home.id} onClose={onClose} />);
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
