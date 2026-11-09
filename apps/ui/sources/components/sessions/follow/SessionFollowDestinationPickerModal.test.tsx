import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SetSessionFollowSourceResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture,
    createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { encodeBase64 } from '@/encryption/base64';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { restoreServerAccountForTest } =
    await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { Encryption } = await import('@/sync/encryption/encryption');
const { storage } = await import('@/sync/domains/state/storageStore');
const { sync } = await import('@/sync/sync');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } =
    await import('@/sync/runtime/orchestration/connectionManager');
const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { SelectionList } = await import('@/components/ui/selectionList');
const { SessionFollowDestinationPickerModal } = await import('./SessionFollowDestinationPickerModal');
const { t } = await import('@/text');
const previousState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseQuery: (() => void) | undefined;

beforeEach(() => network.resetRequests());
afterEach(async () => {
    setScreenSharingPrivacyActive(false);
    clearMachineRequestReachabilityForTest();
    releaseQuery?.();
    releaseQuery = undefined;
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    setServerReachabilityNetworkAllowed(true);
    resetServerFeaturesClientForTests();
    storage.setState(previousState, true);
});
afterAll(() => network.dispose());

async function pickerHome(options: Readonly<{ query?: 'loading' | 'error'; preparation?: 'unreachable' | 'unsupported';
    followDisabled?: boolean }> = {}) {
    const accountId = 'follow-picker-account';
    const serverUrl = 'https://follow-picker.test';
    const secret = new Uint8Array(32).fill(7);
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        secret: encodeBase64(secret, 'base64url') };
    const home = await network.addHome(serverUrl, accountId, { credentials, encryptionMode: 'e2ee' });
    const encryption = await Encryption.create(secret);
    const sourceKey = new Uint8Array(32).fill(9);
    await encryption.initializeSessions(new Map([['source-a', sourceKey]]));
    const sourceReader = encryption.getSessionEncryption('source-a');
    if (!sourceReader) throw new Error('Source encryption fixture was not opened');
    const sourceMetadata = { path: '/source', host: 'test', machineId: 'machine-1' };
    const sourceBase = createPlainSessionCurrentProjectionRecordFixture({ id: 'source-a', metadata: sourceMetadata });
    if (sourceBase.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical owner fixture');
    const source = SessionCurrentProjectionRecordV1Schema.parse({ ...sourceBase,
        encryptionMode: 'e2ee',
        metadata: await sourceReader.encryptRaw(JSON.parse(sourceBase.metadata)),
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: sourceBase.ownerMetadata.v,
            material: { type: 'legacy', secret }, randomBytes: length => new Uint8Array(length).fill(4) }),
        dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sourceKey,
            recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) })),
    });
    const destinationBase = createPlainSessionCurrentProjectionRecordFixture({ id: 'destination-a', active: true,
        activeAt: Date.now(), metadata: { path: '/destination', host: 'test', machineId: 'runner-a' } });
    if (destinationBase.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical owner fixture');
    const destination = SessionCurrentProjectionRecordV1Schema.parse({ ...destinationBase,
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: destinationBase.ownerMetadata.v,
            material: { type: 'legacy', secret }, randomBytes: length => new Uint8Array(length).fill(5) }),
    });
    const page = createSessionListSourceFixture({ sessions: [source, destination].map(record => ({ ...record,
        viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: record.id })) })),
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
    const queryGate = createDeferred<void>();
    if (options.query === 'loading') releaseQuery = () => queryGate.resolve();
    let failQuery = options.query === 'error';
    let queryReads = 0;
    let failCommit = false;
    let sourceUnavailable = options.preparation === 'unreachable';
    let committed = false;
    const order: string[] = [];
    const writes: Array<Readonly<{ path: string; body: unknown }>> = [];
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v2/account/settings' && options.followDisabled) return Response.json({ version: 1, content: { t: 'encrypted',
            c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
                payload: { actionsSettingsV1: { v: 1, actions: { 'follow.set': { enabled: false } } } },
                randomBytes: length => new Uint8Array(length).fill(6),
            }) } });
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
            features: { sessions: { enabled: true, filteredListing: { enabled: true }, following: { enabled: true } } },
        }));
        if (path === '/v1/machines') return Response.json([
            createPlainMachineRowFixture({ id: 'machine-1', accountId }),
            { ...createPlainMachineRowFixture({ id: 'runner-a', accountId }), kind: 'ephemeral_session_runner',
                operationProtocolCapabilities: {} },
        ]);
        if (path === '/v2/sessions/query') {
            queryReads += 1;
            if (options.query === 'loading') await queryGate.promise;
            // A query rejection leaves the Home reachable; a 503 would instead
            // exercise the canonical Home-offline presentation and recovery.
            return failQuery ? Response.json({ errorCode: 'invalid_query' }, { status: 400 }) : Response.json(page);
        }
        if (path === '/v2/sessions/destination-a/follows/sessions/source-a' && init?.method === 'PUT') {
            writes.push({ path, body: JSON.parse(String(init.body)) });
            order.push('set');
            if (failCommit) return Response.json({}, { status: 503 });
            committed = true;
            return Response.json(SetSessionFollowSourceResponseSchema.parse({ changed: true, source: {
                sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'important' },
                deliveryState: 'eligible', hasPendingUpdates: false,
            } }));
        }
        if (path === '/v2/sessions/source-a') {
            if (committed) order.push('prepare');
            return sourceUnavailable && committed
                ? Response.json({}, { status: 404 }) : Response.json({ session: source });
        }
        if (path === '/v2/sessions/destination-a') return Response.json({ session: destination });
        return createEmptyAccountBootstrapHttpResponse(path, init);
    });
    connection = await restoreServerAccountForTest({ serverUrl, accountId, credentials, request: network.request });
    await getServerFeaturesSnapshot({ serverId: home.id, force: true });
    // Preparation independently resolves the exact Runner published by the Home census.
    await sync.refreshMachines();
    return { home, order, writes, queryReads: () => queryReads,
        allowQuery: () => { failQuery = false; }, failCommit: () => { failCommit = true; },
        allowSource: () => { sourceUnavailable = false; } };
}

async function waitForChoices(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.findByType(SelectionList).props.rootStep.sections[0].options, JSON.stringify({
        content: screen.getTextContent(), socket: storage.getState().socketStatus,
        profile: storage.getState().profileScope, applied: getAppliedActiveServerSnapshot(),
        runtime: isAppliedActiveServerRuntimeAvailable(), paths: network.httpRequests.map(request => new URL(request.url).pathname),
        })).not.toHaveLength(0);
    });
}

describe('SessionFollowDestinationPickerModal', () => {
    it('removes a private destination from the loaded query without altering the source', async () => {
        const { home } = await pickerHome();
        const screen = await renderScreen(<SessionFollowDestinationPickerModal
            source={{ serverId: home.id, sessionId: 'source-a' }} onClose={vi.fn()} />);
        await waitForChoices(screen);
        expect(screen.findByTestId('session-follow-destination-option-destination-a')).not.toBeNull();
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [home.id]: ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic(home.id, 'destination-a', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        expect(screen.findByTestId('session-follow-destination-option-destination-a')).toBeNull();
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(screen.findByTestId('session-follow-destination-option-destination-a')).not.toBeNull();
    });

    it('refuses disabled Follow authoring before committing or preparing an encrypted source', async () => {
        const fixture = await pickerHome({ preparation: 'unreachable', followDisabled: true });
        const screen = await renderScreen(<SessionFollowDestinationPickerModal
            destination={{ serverId: fixture.home.id, sessionId: 'destination-a' }} onClose={vi.fn()} />);
        await waitForChoices(screen);
        await screen.pressByTestIdAsync('session-follow-destination-option-source-a');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('errors.unknownError')));
        expect(fixture.writes).toEqual([]);
        expect(fixture.order).toEqual([]);
    });
    it('reserves the rows while the first page loads instead of showing an empty list and a status line', async () => {
        const { home } = await pickerHome({ query: 'loading' });
        const screen = await renderScreen(<SessionFollowDestinationPickerModal
            source={{ serverId: home.id, sessionId: 'source-a' }} onClose={vi.fn()} setChrome={vi.fn()} />);
        await vi.waitFor(() => expect(screen.findByType(SelectionList).props.contentState?.props.testID)
            .toBe('session-follow-destination-loading'));
        expect(screen.findByTestId('session-follow-picker-currentness')).toBeNull();
    });

    it('offers an in-place retry when destination discovery fails for the exact Home', async () => {
        const fixture = await pickerHome({ query: 'error' });
        const screen = await renderScreen(<SessionFollowDestinationPickerModal
            source={{ serverId: fixture.home.id, sessionId: 'source-a' }} onClose={vi.fn()} setChrome={vi.fn()} />);
        await vi.waitFor(async () => { await flushHookEffects();
            expect(screen.getTextContent()).toContain(t('sessionsList.queryRefreshFailedTitle')); });
        expect(screen.getTextContent()).toContain(t('common.retry'));
        const list = screen.findByType(SelectionList);
        const reads = fixture.queryReads();
        fixture.allowQuery();
        await screen.pressByTestIdAsync('session-follow-picker-currentness');
        await waitForChoices(screen);
        expect(fixture.queryReads()).toBe(reads + 1);
        expect(screen.findByType(SelectionList)).toBe(list);
        expect(screen.findByTestId('session-follow-destination-list')).not.toBeNull();
    });

    it('preserves the list lifetime offline and refuses a selection from the previous connected render', async () => {
        const fixture = await pickerHome();
        fixture.failCommit();
        const props = { source: { serverId: fixture.home.id, sessionId: 'source-a' }, onClose: vi.fn() };
        const screen = await renderScreen(<SessionFollowDestinationPickerModal {...props} />);
        await waitForChoices(screen);
        const list = screen.findByType(SelectionList);
        const selectWhileConnected = list.props.onSelect;
        await act(async () => { setServerReachabilityNetworkAllowed(false); });
        await act(async () => { selectWhileConnected('destination-a'); });
        expect(fixture.writes).toHaveLength(0);
        await screen.update(<SessionFollowDestinationPickerModal {...props} setChrome={vi.fn()} />);
        expect(screen.findByType(SelectionList)).toBe(list);
        expect(list.props.rootStep.sections[0].options).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'destination-a', disabled: true }),
        ]));
        await act(async () => { setServerReachabilityNetworkAllowed(true); });
        await vi.waitFor(() => expect(list.props.rootStep.sections[0].options[0].disabled).toBe(false));
        await screen.pressByTestIdAsync('session-follow-destination-option-destination-a');
        await vi.waitFor(() => expect(fixture.writes).toEqual([{
            path: '/v2/sessions/destination-a/follows/sessions/source-a', body: { policy: { preset: 'important' } },
        }]));
    });

    it('commits the edge before preparation and keeps a reachable Retry action when preparation waits', async () => {
        const fixture = await pickerHome({ preparation: 'unreachable' });
        const onClose = vi.fn();
        const onChanged = vi.fn();
        const screen = await renderScreen(<SessionFollowDestinationPickerModal
            destination={{ serverId: fixture.home.id, sessionId: 'destination-a' }} onClose={onClose} onChanged={onChanged} />);
        await waitForChoices(screen);
        await screen.pressByTestIdAsync('session-follow-destination-option-source-a');
        await vi.waitFor(() => expect(fixture.order).toEqual(['set', 'prepare']));
        expect(fixture.writes).toEqual([{
            path: '/v2/sessions/destination-a/follows/sessions/source-a', body: { policy: { preset: 'important' } },
        }]);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-source-key-waiting')).not.toBeNull();
        // This is a later heartbeat, after the first waiting attempt's
        // passive readiness observation has been installed.
        await flushHookEffects();
        const scope = { serverId: fixture.home.id, accountId: 'follow-picker-account' };
        const machine = storage.getState().machines['runner-a'];
        if (!machine) throw new Error('Expected the admitted destination Machine');
        const rootBeforeHeartbeat = storage.getState();
        const attemptsBeforeHeartbeat = fixture.order.length;
        await act(async () => storage.getState().applyMachineActivityUpdates([
            { id: machine.id, active: true, activeAt: machine.activeAt + 1 },
        ], { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }));
        await vi.waitFor(() => expect(fixture.order).toHaveLength(attemptsBeforeHeartbeat + 1));
        expect(storage.getState()).toBe(rootBeforeHeartbeat);
        // Settling another waiting result must not immediately retry itself.
        await flushHookEffects();
        expect(fixture.order).toHaveLength(attemptsBeforeHeartbeat + 1);
        await act(async () => withdrawMachinePresenceForScope(scope));
        await flushHookEffects();
        const attemptsBeforeRecovery = fixture.order.length;
        await act(async () => captureMachinePresenceObservation({ ...scope, accountId: 'another-account' })(['runner-a']));
        expect(fixture.order).toHaveLength(attemptsBeforeRecovery);
        await act(async () => captureMachinePresenceObservation(scope)(['runner-a']));
        await vi.waitFor(() => expect(fixture.order).toHaveLength(attemptsBeforeRecovery + 1));
        const attemptsBeforeRetry = fixture.order.length;
        await screen.pressByTestIdAsync('session-follow-source-key-waiting');
        await vi.waitFor(() => expect(fixture.order).toHaveLength(attemptsBeforeRetry + 1));
        fixture.allowSource();
        await screen.pressByTestIdAsync('session-follow-source-key-waiting');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('session.follow.sources.unsupported')));
        expect(fixture.writes).toHaveLength(1);
    });

    it('asks for a daemon update instead of offering a retry the outdated runtime cannot satisfy', async () => {
        const fixture = await pickerHome({ preparation: 'unsupported' });
        const screen = await renderScreen(<SessionFollowDestinationPickerModal
            destination={{ serverId: fixture.home.id, sessionId: 'destination-a' }} onClose={vi.fn()} />);
        await waitForChoices(screen);
        await screen.pressByTestIdAsync('session-follow-destination-option-source-a');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('session.follow.sources.unsupported')));
        const waiting = screen.findByTestId('session-follow-source-key-waiting')!;
        expect(waiting.props.detail).toBeUndefined();
        expect(waiting.props.onPress).toBeUndefined();
    });
});
