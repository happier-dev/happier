import * as React from 'react';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { renderHook, standardCleanup, createDeferred, createMachineFixture, createSessionAccessFixture } from '@/dev/testkit';
import { createSessionListQuerySourceHarness, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { useDiscussionInviteCandidates } from './useDiscussionInviteCandidates';
import type { DiscussionInviteCandidate } from './discussionInviteCandidates';
import { useExecutableParticipantSections } from './useExecutableParticipantSections';
import { buildExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storageStore';
import { getSessionName, getSessionWorkContext } from '@/utils/sessions/sessionUtils';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readableSessionDisplayTitle, sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { selectSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useSettlingHomeServerId } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { setScreenSharingPrivacyActive(false); await standardCleanup(); await boundary.dispose(); });
const user = (id: string) => ({ id, firstName: id, lastName: null, avatar: null, username: id, bio: null, status: 'none', publicKey: null });
async function captureHome(serverId: string) {
    const hook = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
    await vi.waitFor(() => expect(hook.getCurrent().get(serverId)?.isCurrent()).toBe(true));
    return hook.getCurrent().get(serverId)!;
}

describe('Discussion Invite source composition', () => {
    it.each(['selected', 'unselected'] as const)('loads an uncached Session title from the candidate query for both its picker and sent mention on a %s Home', async (selection) => {
        const home = boundary.serverIds[1]!;
        const lifetime = await captureHome(home);
        if (selection === 'unselected') {
            await boundary.http.selectHomes([boundary.serverIds[0]!]);
            const { isConcurrentOrdinarySessionListHome } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
            await vi.waitFor(() => expect(isConcurrentOrdinarySessionListHome(home)).toBe(false));
        }
        const recentActivityAt = Date.now() - 180_000;
        const record = createPlainSessionCurrentProjectionRecordFixture({ id: 'uncached-reviewer',
            // The wire record carries no separate activity stamp; list rows fall back to creation time.
            createdAt: recentActivityAt,
            metadata: { name: 'Review the opening plan', path: '/shared-folder', host: 'review-box' } });
        boundary.http.answer(home, '/v2/sessions/query', { body: createSessionListSourceFixture({
            sessions: [{ ...record, viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: record.id })) }],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }) });
        expect(selectSessionDisplayNameSource(storage.getState(), record.id, home)).toBeNull();
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { executeDiscussionActionInAccountContext } = await import('@/sync/api/discussions/discussionActions');
        const { DiscussionCandidatesListResultV1Schema } = await import('@happier-dev/protocol/discussions/actions');
        const account = await captureLazyActionAccountContext(home);
        try {
            const outcome = await executeDiscussionActionInAccountContext(account, 'available', {
                actionId: 'discussion.candidates.list', input: { source: 'sessions' },
                context: { surface: 'ui', serverId: home },
            });
            expect(outcome).not.toMatchObject({ ok: false });
            const result = DiscussionCandidatesListResultV1Schema.parse(outcome);
            expect(result.candidates).toContainEqual(expect.objectContaining({ kind: 'session',
                selection: { kind: 'session', session: { serverId: home, sessionId: record.id } } }));
            const { readComposerSessionSuggestionDisplay } = await import('@/sync/domains/input/suggestionSession');
            const { discussionSessionLabel } = await import('./discussionSessionLabel');
            const display = readComposerSessionSuggestionDisplay({ serverId: home, sessionId: record.id });
            expect(display?.title).toBe('Review the opening plan');
            const { getSuggestions } = await import('@/components/autocomplete/suggestions');
            const suggestions = await getSuggestions(null, '@session:', { kinds: ['session'],
                catalogs: { sessions: display ? [display] : [] }, signal: new AbortController().signal });
            expect(suggestions[0]?.label).toBe('Review the opening plan');
            expect(suggestions[0]?.description).toContain(formatRelativeTimeShort(recentActivityAt, Date.now()));
            expect(suggestions[0]?.description).toContain('review-box');
            expect(discussionSessionLabel(selectSessionDisplayNameSource(storage.getState(), record.id, home)))
                .toBe('Review the opening plan');
            expect(lifetime.isCurrent()).toBe(true);
            expect(boundary.http.requests.filter(request => request.serverId === home && request.path === '/v2/sessions/query')).toHaveLength(1);
        } finally { account.dispose(); }
    });
    it('projects Bot identity from the one Session inventory and regroups promotion without another read', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.http.answer(home, '/v1/share-principals', { body: { items: [], nextCursor: null } });
        const records = [
            createPlainSessionCurrentProjectionRecordFixture({ id: 'release-bot', metadata: { host: 'laptop', path: '/work', bot: { kind: 'bot' } } }),
            createPlainSessionCurrentProjectionRecordFixture({ id: 'review-session' }),
        ].map(record => ({ ...record, viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: record.id })) }));
        boundary.http.answer(home, '/v2/sessions/query', { body: createSessionListSourceFixture({ sessions: records,
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) });
        const choose = vi.fn();
        const hook = await renderHook(() => ({
            candidates: useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled: true }),
            picker: useExecutableParticipantSections({ accountLifetime, enabled: true, sessionsContext: 'Reviewer', onChoose: choose }),
        }));
        await vi.waitFor(() => expect(hook.getCurrent().picker.sessions.status).toBe('ready'));
        const groups = () => hook.getCurrent().picker.sections.filter(section => section.id !== 'agents-models');
        expect(groups().map(section => [section.id, section.options.map(option => option.id)]))
            .toEqual([['agents-sessions', ['session:review-session']], ['agents-bots', ['session:release-bot']]]);
        const findCandidate = (id: string) => hook.getCurrent().candidates.candidates.find(candidate =>
            candidate.kind === 'session' && candidate.selection.session.sessionId === id);
        const bot = findCandidate('release-bot');
        expect(bot).toMatchObject({ kind: 'session', bot: true,
            selection: { kind: 'session', session: { serverId: home, sessionId: 'release-bot' } } });
        const botOption = groups()[1]!.options[0]!;
        expect(botOption.titleAccessory).toBeDefined();
        await act(async () => botOption.onSelect?.());
        expect(choose).toHaveBeenCalledWith({ kind: 'session', session: { serverId: home, sessionId: 'release-bot' } });
        const reads = () => boundary.http.requests.filter(request => request.serverId === home
            && (request.path === '/v2/sessions/query' || request.path.startsWith('/v2/sessions/'))).length;
        expect(boundary.http.requests.filter(request => request.serverId === home && request.path === '/v2/sessions/query')).toHaveLength(1);
        const beforeReads = reads();
        const beforeCandidates = hook.getCurrent().candidates.candidates;
        const row = storage.getState().sessionListRowsByServerId[home]!['review-session']!;
        await act(async () => storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId, [home]: { ...state.sessionListRowsByServerId[home],
                'review-session': { ...row, metadata: { ...row.metadata!, bot: { kind: 'bot' } } } },
        } })));
        expect(groups().find(section => section.id === 'agents-sessions')).toBeUndefined();
        expect(groups()[0]?.options.map(option => option.id).sort()).toEqual(['session:release-bot', 'session:review-session']);
        expect(findCandidate('release-bot')).toBe(bot);
        expect(hook.getCurrent().candidates.candidates).not.toBe(beforeCandidates);
        await act(async () => storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId, [home]: { ...state.sessionListRowsByServerId[home], 'review-session': row },
        } })));
        expect(groups().map(section => section.id)).toEqual(['agents-sessions', 'agents-bots']);
        expect(reads()).toBe(beforeReads);
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [home]: ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic(home, 'release-bot', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        expect(groups().flatMap(group => group.options.map(option => option.id))).toEqual(['session:review-session']);
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(groups().flatMap(group => group.options.map(option => option.id))).toContain('session:release-bot');
        await hook.unmount();
    });

    it('updates participant readiness from exact-Home presence while equal heartbeats stay quiet', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        const foreign = await captureHome(boundary.serverIds[0]!);
        boundary.http.answer(home, '/v1/share-principals', { body: { items: [], nextCursor: null } });
        const now = Date.now();
        await publishMachineInventoryForTest(accountLifetime.scope, [createMachineFixture({ id: 'run-host', active: true, activeAt: now })]);
        await publishMachineInventoryForTest(foreign.scope, [createMachineFixture({ id: 'run-host', active: true, activeAt: now })]);
        let renders = 0;
        const onChoose = vi.fn();
        const hook = await renderHook(() => {
            renders += 1;
            return useExecutableParticipantSections({ accountLifetime, enabled: true, sessionsContext: 'Reviewer', onChoose });
        });
        const row = () => hook.getCurrent().sections.flatMap(section => section.options).find(option => option.id === 'model:run-host');
        await vi.waitFor(() => expect(row()?.readiness).toMatchObject({ status: 'ready' }));
        const baseline = renders;
        try {
            await act(async () => {
                for (let tick = 1; tick <= 10; tick += 1) storage.getState().applyMachineActivityUpdates([
                    { id: 'run-host', active: true, activeAt: now + tick },
                ], { sourceServerId: home, sourceAccountId: accountLifetime.scope.accountId });
                recordMachineRequestFailed({ ...foreign.scope, machineId: 'run-host' });
            });
            expect(renders).toBe(baseline);
            expect(row()?.readiness).toMatchObject({ status: 'ready' });
            await act(async () => recordMachineRequestFailed({ ...accountLifetime.scope, machineId: 'run-host' }));
            expect(row()?.readiness).toMatchObject({ status: 'offline' });
            await act(async () => clearMachineRequestReachabilityForTest());
            expect(row()?.readiness).toMatchObject({ status: 'ready' });
            vi.useFakeTimers({ toFake: ['Date'] });
            const expiredAt = now + 100_000;
            vi.setSystemTime(expiredAt);
            await act(async () => {
                storage.getState().applyMachineActivityUpdates([{ id: 'run-host', active: false, activeAt: now + 10 }],
                    { sourceServerId: home, sourceAccountId: accountLifetime.scope.accountId });
                storage.getState().applyMachineActivityUpdates([{ id: 'run-host', active: true, activeAt: expiredAt }],
                    { sourceServerId: foreign.scope.serverId, sourceAccountId: foreign.scope.accountId });
            });
            expect(row()?.readiness).toMatchObject({ status: 'offline' });
        } finally { vi.useRealTimers(); clearMachineRequestReachabilityForTest(); }
    });

    it.each(['codex', 'test.vendor/reviewer'])('indexes the published Session catalog for %s on the selected Run machine', async agentId => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.http.answer(home, '/v1/share-principals', { body: { items: [], nextCursor: null } });
        const { buildSessionModelsSeedRequest } = await import('@/sync/domains/models/sessionModelsSeed');
        const seed = buildSessionModelsSeedRequest({ agentId, currentTargetKey: 'catalog-target', preflightTargetKey: 'catalog-target',
            preflightModels: { availableModels: [{ id: 'gpt-review', name: 'GPT review' }], supportsFreeform: false },
            currentModelId: 'gpt-review', hasCuratedStaticModels: false, updatedAt: 1 });
        if (!seed) throw new Error('Expected the model catalog producer to accept its matching target');
        boundary.setRows(home, ['prior-agent']);
        const session = createSessionFixture({ id: 'prior-agent', serverId: home, encryptionMode: 'plain',
            seq: 2, metadataVersion: 2, metadataLayoutVersion: 1,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId } }, 1),
            ownerMetadataView: { machineId: 'old-host', path: '/work', host: 'old-host' },
            composerOptionsInput: { sessionModelsV1: { v: 1, ...seed } },
            access: createSessionAccessFixture('owner') });
        await publishMachineInventoryForTest(accountLifetime.scope, [
            createMachineFixture({ id: 'old-host', active: false, activeAt: 0 }),
            createMachineFixture({ id: 'run-host', active: true, activeAt: Date.now() }),
        ]);
        const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
            preferredMachineId: 'run-host', query: 'GPT review', sessionsContext: 'Reviewer', onChoose: vi.fn() }));
        const row = () => hook.getCurrent().sections.flatMap(section => section.options)
            .find(option => option.id === `model:run-host:${agentId}`);
        await vi.waitFor(() => expect(hook.getCurrent().sessions.status).toBe('ready'));
        await act(async () => storage.getState().applySessions([session]));
        await vi.waitFor(() => expect(row()?.readiness).toMatchObject({ status: 'ready' }));
        expect(row()?.searchText).toContain('GPT review');
    });

    it('omits retired model targets and puts scoped available Machines before retained unavailable setup choices', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const machine = (id: string, overrides: Parameters<typeof createMachineFixture>[0] = {}) => createMachineFixture({
            id, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, displayName: id }, ...overrides,
        });
        const inventory = [
            machine('a-offline', { active: false, activeAt: 0 }),
            machine('b-unknown'),
            machine('c-failed'),
            machine('removed', { revokedAt: 1 }),
            machine('replaced', { replacedByMachineId: 'z-ready' }),
            machine('ephemeral', { kind: 'ephemeral_session_runner' }),
            machine('z-ready'),
            machine('y-ready', { revokedAt: 0, replacedByMachineId: '  ' }),
        ];
        withdrawMachinePresenceForScope(accountLifetime.scope);
        captureMachinePresenceObservation(accountLifetime.scope)(inventory.filter(row => row.id !== 'b-unknown').map(row => row.id));
        recordMachineRequestFailed({ ...accountLifetime.scope, machineId: 'c-failed' });
        try {
            storage.setState({ machineListByServerId: { [home]: inventory } });
            const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
                sessionsContext: 'Reviewer', onChoose: vi.fn() }));
            const options = () => hook.getCurrent().sections.find(section => section.id === 'agents-models')?.options ?? [];
            const ids = ['model:y-ready', 'model:z-ready', 'model:a-offline', 'model:b-unknown', 'model:c-failed'];
            await vi.waitFor(() => expect(hook.getCurrent().sessions.status).toBe('ready'));
            expect(options().map(option => option.id)).toEqual(ids);
            expect(options().map(option => option.readiness && 'status' in option.readiness ? option.readiness.status : null))
                .toEqual(['ready', 'ready', 'offline', 'unknown', 'offline']);
            expect(options().every(option => !option.disabled)).toBe(true);
            await act(async () => { storage.setState({ machineListByServerId: { [home]: [...inventory].reverse() } }); });
            expect(options().map(option => option.id)).toEqual(ids);
        } finally {
            clearMachineRequestReachabilityForTest();
        }
    });

    it('says once, at the top of Who answers, that nothing of the viewer\'s can answer while none of their Machines is ready', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const machine = (id: string, overrides: Parameters<typeof createMachineFixture>[0] = {}) => createMachineFixture({
            id, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, displayName: id }, ...overrides,
        });
        // The listed Sessions run on machine-1 (the Session fixture's Machine).
        const offline = [machine('machine-1', { active: false, activeAt: 0 }), machine('build-box', { active: false, activeAt: 0 })];
        withdrawMachinePresenceForScope(accountLifetime.scope);
        captureMachinePresenceObservation(accountLifetime.scope)(offline.map(row => row.id));
        try {
            storage.setState({ machineListByServerId: { [home]: offline } });
            const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
                sessionsContext: 'Reviewer', onChoose: vi.fn() }));
            const models = () => hook.getCurrent().sections.find(section => section.id === 'agents-models')?.options ?? [];
            const statusRows = () => hook.getCurrent().sections.flatMap(section => section.options)
                .filter(option => option.testID === 'discussion-invite-sessions-unavailable');
            await vi.waitFor(() => expect(hook.getCurrent().sessions.status).toBe('ready'));
            await vi.waitFor(() => expect(hook.getCurrent().sections.find(section => section.id === 'agents-sessions')?.options
                .some(option => option.id.startsWith('session:'))).toBe(true));
            // One line, first in the list of new reviewers, and not a choice; each row keeps its own cause.
            expect(statusRows()).toHaveLength(1);
            expect(models()[0]).toMatchObject({ testID: 'discussion-invite-sessions-unavailable',
                label: t('session.collaboration.discussion.secondOpinion.nothingCanAnswer'), disabled: true });
            expect(models().slice(1).map(option => option.subtitle))
                .toEqual(models().slice(1).map(() => t('session.collaboration.readiness.cause.machineOffline')));
            // A Machine of theirs coming back is something that can answer: the line goes.
            await act(async () => { storage.setState({ machineListByServerId: { [home]: [offline[0]!, machine('build-box')] } }); });
            expect(statusRows()).toHaveLength(0);
        } finally {
            clearMachineRequestReachabilityForTest();
        }
    });
    it('projects encrypted title readability from the exact Home title owner and tracks unlock without label heuristics', async () => {
        const [focusedHome, home] = boundary.serverIds as [string, string, string];
        const accountLifetime = await captureHome(home);
        boundary.setRows(home, ['same-id', 'readable']);
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        let candidatePublications = 0;
        const hook = await renderHook(() => {
            const source = useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled: true });
            React.useEffect(() => { candidatePublications += 1; }, [source.candidates]);
            return source;
        });
        await vi.waitFor(() => expect(hook.getCurrent().candidates.filter(candidate => candidate.kind === 'session')).toHaveLength(2));
        const readable = createSessionFixture({ id: 'readable', serverId: home, encryptionMode: 'e2ee', metadataLayoutVersion: 1,
            encryptedContentAvailability: 'ready', metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
            ownerMetadataView: { name: 'Cached private review', host: 'review-box', path: '/release' } });
        const locked = { ...readable, id: 'same-id', encryptedContentAvailability: 'encrypted_access_pending' as const,
            // A recipient remains visible but has no Account-owned title view to open.
            // An owner with an unavailable envelope is deliberately not a list candidate:
            // its private hidden-system classification cannot be established.
            access: createSessionAccessFixture('edit'), accessLevel: 'edit' as const,
            metadata: null, ownerMetadataView: null };
        await act(async () => { storage.setState(state => ({
            sessions: { ...state.sessions, 'same-id': createSessionFixture({ id: 'same-id', serverId: focusedHome,
                encryptionMode: 'plain', metadata: { name: 'Readable other Home', host: 'other', path: '/other' } }) },
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [home]: {
                ...state.sessionListRowsByServerId[home], 'same-id': buildSessionListRenderableFromSession(locked),
                readable: buildSessionListRenderableFromSession(readable),
            } },
        })); });
        const candidates = hook.getCurrent().candidates;
        const lockedCandidate = candidates.find(candidate => candidate.kind === 'session' && candidate.selection.session.sessionId === 'same-id');
        const readableCandidate = candidates.find(candidate => candidate.kind === 'session' && candidate.selection.session.sessionId === 'readable');
        const lockedSource = selectSessionDisplayNameSource(storage.getState(), 'same-id', home);
        const readableSource = selectSessionDisplayNameSource(storage.getState(), 'readable', home);
        expect(readableCandidate).toMatchObject({ label: sessionDisplayTitle(readableSource), titleReadable: true });
        expect(readableCandidate?.kind === 'session' && readableCandidate.label).toBe('Cached private review');
        expect(readableSessionDisplayTitle(lockedSource)).toBeNull();
        expect(lockedCandidate).toMatchObject({ label: sessionDisplayTitle(lockedSource), titleReadable: false });
        const lockedLabel = sessionDisplayTitle(lockedSource)!;
        const publicationsBeforeForeignUpdate = candidatePublications;
        for (let update = 0; update < 10; update += 1) {
            await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions,
                'same-id': { ...state.sessions['same-id']!, metadata: { name: 'Changed other Home', host: 'other', path: '/other' } },
            } })); });
        }
        expect(hook.getCurrent().candidates).toBe(candidates);
        expect(candidatePublications).toBe(publicationsBeforeForeignUpdate);
        await act(async () => { storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId, [home]: { ...state.sessionListRowsByServerId[home],
                'same-id': buildSessionListRenderableFromSession({ ...locked, encryptedContentAvailability: 'ready',
                    metadata: parseDecryptedSessionMetadata({ v: 1, summary: { text: lockedLabel, updatedAt: 1 } }, 1) }),
            },
        } })); });
        expect(hook.getCurrent().candidates).not.toBe(candidates);
        expect(candidatePublications).toBe(publicationsBeforeForeignUpdate + 1);
        expect(hook.getCurrent().candidates.find(candidate => candidate.key === readableCandidate?.key)).toBe(readableCandidate);
        expect(hook.getCurrent().candidates.find(candidate => candidate.key === lockedCandidate?.key)).not.toBe(lockedCandidate);
        // A readable title may deliberately have the same words as the locked label.
        expect(hook.getCurrent().candidates.find(candidate => candidate.kind === 'session' && candidate.selection.session.sessionId === 'same-id'))
            .toMatchObject({ key: lockedCandidate?.key, label: lockedLabel, titleReadable: true });
    });

    it('keeps an offline model target in the demanded picker with its readiness and repair data', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        storage.setState({ machineListByServerId: { [home]: [createMachineFixture({ id: 'offline-target', active: false, activeAt: 0 })] } });
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const selected = buildExecutableParticipantPickerOption({ label: 'Configured model',
            selection: { kind: 'model', launch: { executionTarget: { serverId: home, machineId: 'offline-target' },
                directory: { kind: 'path', path: '/work' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } },
            readiness: { configured: true, machine: { selectedMachineId: 'offline-target', machine: null },
                agent: null, selection: null, inventory: { status: 'idle', lastCheckedAt: null },
                invocation: null, mayRepairAgent: false } });
        if (!selected) throw new Error('Invalid selected model fixture');
        const choose = vi.fn();
        const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
            modelOptions: [selected], sessionsContext: 'Answers with its own setup', onChoose: choose }));
        await vi.waitFor(() => expect(hook.getCurrent().sessions.status).toBe('ready'));
        const option = hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'model:offline-target');
        expect(option).toMatchObject({ readiness: { status: 'offline', machineId: 'offline-target' }, repair: null });
        // Listed and selectable, with its one cause instead of the usual hint; never hidden.
        expect(option?.subtitle).toBe(t('session.collaboration.readiness.cause.machineOffline'));
        expect(option?.disabled).toBe(false);
        const configured = hook.getCurrent().sections.flatMap(section => section.options).find(option => option.label === selected.label)!;
        expect(configured.readiness).toBe(selected.readiness);
        expect(configured.repair).toBe(selected.repair);
        configured.onSelect?.();
        expect(choose).toHaveBeenCalledWith(selected.value);
    });
    it('carries the sidebar title and work context through the captured-Home participant presenter', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.setRows(home, ['same-id']);
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const choose = vi.fn();
        const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
            sessionsContext: 'Answers with its own setup', onChoose: choose }));
        await vi.waitFor(() => expect(hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .some(option => option.id === 'session:same-id')).toBe(true));
        const session = createSessionFixture({ id: 'same-id', serverId: home, encryptionMode: 'e2ee', metadataLayoutVersion: 1,
            meaningfulActivityAt: Date.now() - 180_000,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1),
            ownerMetadataView: { name: 'Release review', host: 'review-box', path: '/release' } });
        const row = buildSessionListRenderableFromSession(session);
        await act(async () => { storage.setState(state => ({
            sessions: { ...state.sessions, 'same-id': createSessionFixture({ id: 'same-id', serverId: boundary.serverIds[0],
                metadata: { name: 'Wrong Home', host: 'other', path: '/wrong' } }) },
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
                [home]: { ...state.sessionListRowsByServerId[home], 'same-id': row } },
        })); });
        const option = hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'session:same-id')!;
        expect(option.label).toBe(getSessionName(row, home));
        expect(option.label).toBe('Release review');
        expect(option.subtitle).toContain('Codex');
        expect(option.subtitle).toContain('review-box');
        expect(option.subtitle).toContain(formatRelativeTimeShort(session.meaningfulActivityAt!, Date.now()));
        // How a session takes part is said once, beside the section title, not repeated on every row.
        expect(option.subtitle).not.toContain('Answers with its own setup');
        // The row leads with the Agent's own mark, the identity its byline names, not a generic robot.
        expect((option.icon as React.ReactElement<{ agentId?: string }>).props.agentId).toBe('codex');
        option.onSelect?.();
        expect(choose).toHaveBeenCalledWith({ kind: 'session', session: { serverId: home, sessionId: 'same-id' } });
        // When no Agent/Machine identity is recorded, the list's public recency still distinguishes rows.
        const activityAt = Date.parse('2026-10-19T03:42:00.000Z');
        const unnamedRow = buildSessionListRenderableFromSession({ ...session,
            metadata: { path: '', host: '' }, ownerMetadataView: { path: '', host: '' },
            encryptedContentAvailability: 'ready', meaningfulActivityAt: activityAt });
        expect(getSessionWorkContext(unnamedRow, home)).toBeNull();
        await act(async () => { storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId, [home]: { ...state.sessionListRowsByServerId[home], 'same-id': unnamedRow },
        } })); });
        const unnamedOption = hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'session:same-id')!;
        expect(unnamedOption.subtitle).toContain(formatRelativeTimeShort(activityAt, Date.now()));
        expect(unnamedOption.subtitle).not.toContain('review-box');
        // Without a recorded Agent it keeps the Agent catalog's own neutral mark, not a hand-picked glyph.
        expect((unnamedOption.icon as React.ReactElement<{ agentId?: string | null }>).props.agentId).toBeNull();
    });
    it('uses captured-Home people paging and the real existing Session roster without borrowing the focused Home', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        const accountLifetime = await captureHome(homeB);
        const focusedHome = boundary.focusedHome();
        boundary.setRows(homeA, ['same-id']);
        boundary.setRows(homeB, ['same-id', 'joined']);
        boundary.http.answer(homeB, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        boundary.http.answer(homeB, '/v1/user/search', { select: (_input, request) => {
            const url = new URL(request.url);
            expect(url.searchParams.get('purpose')).toBe('collaboration');
            expect(url.searchParams.get('query')).toBe('person');
            return { body: { users: url.searchParams.has('cursor') ? [user('person-page-two')] : [user('invited'), user('person-page-one')],
                nextCursor: url.searchParams.has('cursor') ? null : 'people-2' } };
        } });
        const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'd', ownerAccountId: accountLifetime.scope.accountId,
            access: 'owner', grants: [{ principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit',
                createdByAccountId: accountLifetime.scope.accountId, createdAt: 1, display: { name: null } }],
            participants: [{ participant: { kind: 'session', sessionId: 'joined' }, answerPolicy: 'when_addressed', createdAt: 1 }],
        });
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled, roster }), {
            initialProps: { enabled: false },
        });
        expect(hook.getCurrent().candidates).toEqual([]);
        expect(boundary.queryRequests).toEqual([]);
        expect(await hook.getCurrent().people.resolve('person', new AbortController().signal)).toEqual([]);
        await hook.rerender({ enabled: true });
        await vi.waitFor(() => expect(hook.getCurrent().sessions.state?.phase).toBe('ready'));
        expect(hook.getCurrent().candidates.filter(candidate => candidate.kind === 'session').map(candidate => candidate.selection.session))
            .toEqual([{ serverId: homeB, sessionId: 'same-id' }]);
        let people: readonly Extract<DiscussionInviteCandidate, { kind: 'account' }>[] = [];
        await act(async () => { people = await hook.getCurrent().people.resolve('person', new AbortController().signal); });
        expect(people.map(candidate => candidate.participant.accountId)).toEqual(['person-page-one']);
        expect(hook.getCurrent().people.hasMore).toBe(true);
        await act(async () => hook.getCurrent().people.loadMore());
        await vi.waitFor(() => expect(hook.getCurrent().people.hasMore).toBe(false));
        await act(async () => { people = await hook.getCurrent().people.resolve('person', new AbortController().signal); });
        expect(people.map(candidate => candidate.participant.accountId)).toEqual(['person-page-one', 'person-page-two']);
        await act(async () => hook.getCurrent().sessions.loadMore());
        expect(hook.getCurrent().sessions.complete).toBe(true);
        expect(boundary.focusedHome()).toBe(focusedHome);
        expect(boundary.queryRequests.every(request => request.serverId === homeB)).toBe(true);
        const peopleRequests = boundary.http.requests.filter(request => request.path.startsWith('/v1/user/search?'));
        expect(peopleRequests).toHaveLength(2);
        expect(peopleRequests.every(request => request.serverId === homeB)).toBe(true);
    });

    it('projects only active Team members and withdraws a captured Account on retirement', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.http.answer(home, '/v1/teams/members/list', { body: { items: [
            teamMembershipFixture({ accountId: 'team-person' }),
            teamMembershipFixture({ id: 'suspended', accountId: 'suspended', status: 'suspended' }),
        ], nextCursor: null } });
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [teamSummaryFixture()], nextCursor: null } });
        const hook = await renderHook(() => useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled: true,
            teamAddress: { serverId: home, teamId: 'team-1' } }));
        await vi.waitFor(() => expect(hook.getCurrent().candidates.filter(candidate => candidate.kind === 'account').map(candidate => candidate.participant.accountId))
            .toEqual(['team-person']));
        await act(async () => boundary.switchAccount(home, 'replacement'));
        expect(accountLifetime.isCurrent()).toBe(false);
        expect(hook.getCurrent().candidates).toEqual([]);
        expect(await hook.getCurrent().people.resolve('', new AbortController().signal)).toEqual([]);
    });

    it('cancels a captured Account lookup instead of exposing a late old-Account result', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        const gate = createDeferred<void>();
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const hook = await renderHook(() => useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled: true }));
        boundary.http.answer(home, '/v1/user/search', { status: 503, body: {} });
        await act(async () => {
            await expect(hook.getCurrent().people.resolve('offline', new AbortController().signal)).rejects.toThrow();
        });
        boundary.http.answer(home, '/v1/user/search', { body: { users: [user('late-person')], nextCursor: null }, respondAfter: gate.promise });
        let pending!: Promise<unknown>;
        await act(async () => { pending = hook.getCurrent().people.resolve('late', new AbortController().signal).catch(error => error); });
        await vi.waitFor(() => expect(boundary.http.requests.filter(request => request.path.startsWith('/v1/user/search?'))).toHaveLength(2));
        await act(async () => boundary.switchAccount(home, 'replacement'));
        gate.resolve();
        expect(await pending).toEqual([]);
        expect(hook.getCurrent().candidates).toEqual([]);
    });

    describe('the Session choices say what the listing is doing', () => {
        const sessionOptions = (sections: ReturnType<typeof useExecutableParticipantSections>['sections']) =>
            sections.find(section => section.id === 'agents-sessions')?.options ?? [];
        const find = (sections: ReturnType<typeof useExecutableParticipantSections>['sections'], testID: string) =>
            sessionOptions(sections).find(option => option.testID === testID);
        const mountPicker = async (home: string) => {
            const accountLifetime = await captureHome(home);
            boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
            const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
                sessionsContext: 'Reviewer', onChoose: vi.fn() }));
            return { accountLifetime, hook };
        };

        it.each([
            { status: 400, reason: 'invalid_query' },
            { status: 200, reason: 'response' },
        ])('shows a terminal first-page HTTP $status failure on the settling applied Home and retries exactly that request', async ({ status, reason }) => {
            const home = boundary.focusedHome();
            const accountLifetime = await captureHome(home);
            boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
            const gate = createDeferred<void>();
            boundary.http.answer(home, '/v2/sessions/query', { status, body: {}, respondAfter: gate.promise });
            const hook = await renderHook(() => ({
                ...useExecutableParticipantSections({ accountLifetime, enabled: true,
                    sessionsContext: 'Reviewer', onChoose: vi.fn() }),
                settlingHome: useSettlingHomeServerId(),
            }));
            const queryCount = () => boundary.http.requests.filter(request => request.path === '/v2/sessions/query'
                && request.serverId === home).length;
            await vi.waitFor(() => expect(queryCount()).toBeGreaterThan(0));
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeDefined();
            // Real transport loss keeps the Home settling even after the Home
            // owner corrects its unknown-Machine-count projection.
            await act(async () => { boundary.loseTransport(home); });
            expect(hook.getCurrent().settlingHome).toBe(home);
            await act(async () => gate.resolve());
            await vi.waitFor(() => expect(hook.getCurrent().sessions.state).toMatchObject({
                phase: 'error', failureReason: reason, failedOperation: 'replace', appliedQueryKey: null,
            }));
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeUndefined();
            const retry = find(hook.getCurrent().sections, 'discussion-invite-sessions-retry');
            expect(retry).toBeDefined();
            const beforeUnrelated = queryCount();
            await act(async () => {
                for (let index = 0; index < 10; index += 1) storage.getState().applyLocalSettings({
                    uiFontScale: index % 2 === 0 ? 1.1 : 1.2,
                }, { persist: false });
            });
            expect(queryCount()).toBe(beforeUnrelated);

            await act(async () => { boundary.socket(home).connect(); });
            await vi.waitFor(() => expect(storage.getState().socketStatus).toBe('connected'));
            boundary.http.answer(home, '/v2/sessions/query', { body: createSessionListSourceFixture({
                sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({ id: 'recovered-terminal' }),
                    viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: 'recovered-terminal' })) }],
                nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            }) });
            const beforeRetry = queryCount();
            await act(async () => { await retry!.onSelect?.(); });
            await vi.waitFor(() => expect({ phase: hook.getCurrent().sessions.state?.phase,
                failureReason: hook.getCurrent().sessions.state?.failureReason,
                requests: queryCount() - beforeRetry,
            }).toEqual({ phase: 'ready', failureReason: null, requests: 1 }));
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id))
                .toContain('session:recovered-terminal'));
            expect(queryCount() - beforeRetry).toBe(1);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
        });

        it('says it is looking while the first page loads, then offers Retry for a failed first page and recovers the choices', async () => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['recovered']);
            boundary.failQueries(home, 'all');
            boundary.holdQueries(home);
            const { hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeDefined());
            const loading = find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')!;
            expect(loading.label).toBe(t('workflows.conversation.sessionsLoading'));
            expect(loading.disabled).toBe(true);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            await act(async () => boundary.releaseQueries(home));
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeDefined());
            // No continuation exists after a failed first page: it is not presented as pagination.
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeUndefined();
            const retry = find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')!;
            expect(retry.label).toBe(t('workflows.conversation.sessionsFailed'));
            expect(retry.subtitle).toBe(t('workflows.conversation.retryLoadingSessions'));
            expect(retry.disabled).toBeFalsy();
            boundary.failQueries(home, null);
            const before = boundary.queryRequests.length;
            await act(async () => retry.onSelect?.());
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:recovered'));
            expect(boundary.queryRequests.slice(before).every(request => request.cursor === null)).toBe(true);
            expect(boundary.queryRequests.length).toBeGreaterThan(before);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
        });

        it('offers More sessions only while a continuation exists, and a page loads on choosing it', async () => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['first']);
            const { hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeDefined());
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeUndefined();
            await act(async () => find(hook.getCurrent().sections, 'discussion-invite-sessions-more')!.onSelect?.());
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain(`session:${boundary.accountId(home)}-page-2`));
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            expect(boundary.queryRequests.some(request => request.cursor === `cursor:${boundary.accountId(home)}`)).toBe(true);
        });

        it('keeps the loaded Sessions when a next page fails and retries that page', async () => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['first']);
            const { hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeDefined());
            boundary.failQueries(home, 'nextPage');
            await act(async () => find(hook.getCurrent().sections, 'discussion-invite-sessions-more')!.onSelect?.());
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeDefined());
            const retry = find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')!;
            expect(retry.label).toBe(t('session.collaboration.discussion.participants.moreSessionsFailed'));
            expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:first');
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            boundary.failQueries(home, null);
            const beforeRetry = boundary.queryRequests.length;
            await act(async () => retry.onSelect?.());
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain(`session:${boundary.accountId(home)}-page-2`));
            expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:first');
            // The retry asked for the failed page, not a fresh first page.
            expect(boundary.queryRequests.slice(beforeRetry).map(request => [request.serverId, request.cursor]))
                .toEqual([[home, `cursor:${boundary.accountId(home)}`]]);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
        });

        it('retries the failed replacement after an exact-Home change even while the old page retains a cursor', async () => {
            const [wrongHome, home] = boundary.serverIds as [string, string, string];
            boundary.setRows(home, ['first']);
            const { hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeDefined());
            const beforeInvalidation = boundary.queryRequests.length;
            await act(async () => publishHomeAccountChange(wrongHome, ['new-head'], { sessionListQueryAffects: true }));
            expect(boundary.queryRequests).toHaveLength(beforeInvalidation);

            boundary.failQueries(home, 'all');
            await act(async () => publishHomeAccountChange(home, ['new-head'], { sessionListQueryAffects: true }));
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeDefined());
            expect(boundary.queryRequests.slice(beforeInvalidation).map(request => [request.serverId, request.cursor]))
                .toEqual([[home, null]]);
            expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:first');

            boundary.setRows(home, ['new-head', 'first']);
            boundary.failQueries(home, null);
            const beforeRetry = boundary.queryRequests.length;
            await act(async () => find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')!.onSelect?.());
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:new-head'));
            expect(boundary.queryRequests.slice(beforeRetry).map(request => [request.serverId, request.cursor]))
                .toEqual([[home, null]]);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
        });

        it.each(['initial', 'replacement'] as const)('presents nothing and reads nothing after Account retirement following a failed %s read', async (operation) => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['first']);
            if (operation === 'initial') boundary.failQueries(home, 'all');
            const { accountLifetime, hook } = await mountPicker(home);
            if (operation === 'replacement') {
                await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeDefined());
                boundary.failQueries(home, 'all');
                await act(async () => publishHomeAccountChange(home, ['new-head'], { sessionListQueryAffects: true }));
            }
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeDefined());
            const retry = find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')!;
            await act(async () => boundary.switchAccount(home, 'replacement'));
            expect(accountLifetime.isCurrent()).toBe(false);
            expect(sessionOptions(hook.getCurrent().sections)).toEqual([]);
            boundary.failQueries(home, null);
            const before = boundary.queryRequests.length;
            await act(async () => retry.onSelect?.());
            expect(boundary.queryRequests).toHaveLength(before);
        });
    });
});
