import * as React from 'react';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createSessionFixture, createPlainSessionCurrentProjectionRecordFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { ModalProvider } from '@/modal';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

// Native presentation SDKs and HTTP/socket transports are genuine boundaries;
// the mounted setup host, profile reader and revision-aware Action executor stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
const { SessionSetupSections } = await import('./SessionSetupSections');
const initialState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(initialState, true); });

describe('Session setup approval profile', () => {
    it.each(['apply', 'keep'] as const)('shows the typed missing fallback and holds an explicit clear against a newer Session until %s', async decision => {
        const account = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: {}, approvalProfiles: [] },
        }) });
        const disposeLoader = await installRealActionExecutorModuleLoader();
        try {
            const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
            const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
            const request = account.request.getMockImplementation();
            if (!request) throw new Error('Account HTTP boundary missing');
            account.request.mockImplementation(async (input, init) => await sessionRequest(input, init) ?? request(input, init));
            const current = createSessionFixture({ serverId: account.scope.serverId, metadataVersion: 5 });
            current.metadataLayoutVersion = 1;
            current.ownerMetadataView = { ...current.metadata!, approvalProfileId: 'custom:removed' };
            sessionHttp.replaceSession(current.id, createPlainSessionCurrentProjectionRecordFixture({
                id: current.id, metadata: current.ownerMetadataView, metadataVersion: current.metadataVersion,
                agentStateVersion: current.agentStateVersion,
            }));
            storage.setState({ sessions: { ...storage.getState().sessions, [current.id]: current } });
            const readPersistedProfile = async () => {
                const response = sessionHttp.handle(`https://fixture.invalid/v2/sessions/${current.id}`);
                if (!response) throw new Error('Session HTTP fixture missing');
                const payload: unknown = await response.json();
                if (!payload || typeof payload !== 'object' || !('session' in payload)) throw new Error('Session HTTP response missing');
                const row = SessionCurrentProjectionRecordV1Schema.parse(payload.session);
                if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain Session owner fixture');
                return row.ownerMetadata.v.runtime?.approvalProfileId;
            };
            const stale = { ...current, metadataVersion: 4 };
            const element = (session: typeof current) => <InjectedAuthProvider credentials={account.credentials}><ModalProvider><SessionSetupSections session={session} serverId={account.scope.serverId} /></ModalProvider></InjectedAuthProvider>;
            const screen = await renderScreen(element(stale));
            try {
                await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'session-approval-profile-missing' }).length).toBeGreaterThan(0));
                const picker = screen.tree.root.findAllByType(DropdownMenu).find(row => row.props.testID === 'session-approval-profile');
                if (!picker) throw new Error('Session approval profile picker missing');
                await act(async () => picker.props.onSelect('__none__'));
                await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'session-approval-profile-conflict' }).length).toBeGreaterThan(0));
                // The boundary counts attempted PATCHes, including independent projection
                // maintenance. The owner's persisted profile must retain the refused intent.
                expect(await readPersistedProfile()).toBe('custom:removed');
                await screen.update(element(storage.getState().sessions[current.id]!));
                await screen.pressByTestIdAsync(`session-approval-profile-conflict.${decision}`);
                await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'session-approval-profile-conflict' })).toHaveLength(0));
                if (decision === 'apply') {
                    await vi.waitFor(() => expect(readSessionOwnerMetadataView(storage.getState().sessions[current.id]!)?.approvalProfileId).toBeNull());
                    expect(await readPersistedProfile()).toBeNull();
                } else {
                    expect(await readPersistedProfile()).toBe('custom:removed');
                    expect(readSessionOwnerMetadataView(storage.getState().sessions[current.id]!)?.approvalProfileId).toBe('custom:removed');
                }
            } finally { await screen.unmount(); }
        } finally { disposeLoader(); await account.dispose(); }
    });
});
