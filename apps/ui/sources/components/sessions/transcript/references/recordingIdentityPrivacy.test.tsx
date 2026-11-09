import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createSessionFixture, renderHook, renderScreen, renderWithSessionTranscriptSource, createTestSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const initial = storage.getState();
const address = { serverId: 'home-a', sessionId: 'private-session' };
const title = 'Confidential acquisition';
beforeEach(() => {
    const session = createSessionFixture({ id: address.sessionId, serverId: address.serverId,
        metadata: { ...createSessionFixture().metadata!, name: title } });
    storage.setState({ sessions: { [session.id]: session }, settings: { ...initial.settings,
        sessionListHiddenTagIdsWhileRecording: { [address.serverId]: ['private'] } },
        sessionOrganizationTagAssignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey(address.serverId, session.id)]: { sessionId: session.id, tagIds: ['private'] },
        } });
    setScreenSharingPrivacyActive(true);
});
afterEach(async () => { await standardCleanup(); setScreenSharingPrivacyActive(false); storage.setState(initial, true); });

describe('incidental Session identity during recording', () => {
    it('masks transcript provenance and restores it when sharing ends', async () => {
        const { useTranscriptSessionIdentity } = await import('./useTranscriptSessionIdentity');
        const hook = await renderHook(() => useTranscriptSessionIdentity(address.sessionId, address.serverId));
        expect(hook.getCurrent().name).toBe(t('message.provenanceSession'));
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(hook.getCurrent().name).toBe(title);
    });

    it('masks Artifact source identity while retaining the configured source link', async () => {
        const { ArtifactProvenanceLabel } = await import('@/components/artifacts/ArtifactProvenance');
        const screen = await renderScreen(<ArtifactProvenanceLabel provenance={{ sha: 'a'.repeat(64),
            sessionId: address.sessionId, machineId: 'machine-1', path: '/private/report.md' }}
            fallback="" presentation="chip" testID="source" />);
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain(title);
        expect(screen.findByTestId('source:open')).not.toBeNull();
    });

    it('masks structured reference live and captured labels without disabling navigation', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');
        const navigate = vi.fn();
        const screen = await renderWithSessionTranscriptSource(<StructuredReferencesRow sessionId="opened-session"
            serverId={address.serverId} references={[{ kind: 'session', sessionId: address.sessionId, label: title }]}
            fileOpenEnabled={false} />, createTestSessionTranscriptSource({ sessionId: 'opened-session', navigate }));
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain(title);
        await screen.pressByTestIdAsync(`transcript-session-reference:${address.sessionId}`);
        expect(navigate).toHaveBeenCalled();
    });

    it('masks a fork parent name while retaining its link', async () => {
        const { ForkDividerRow } = await import('../forkContext/ForkDividerRow');
        const screen = await renderWithSessionTranscriptSource(<ForkDividerRow parentSessionId={address.sessionId}
            childSessionId="opened-session" serverId={address.serverId} parentCutoffSeqInclusive={1} />,
        createTestSessionTranscriptSource({ sessionId: 'opened-session', navigate: vi.fn() }));
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain(title);
        expect(screen.findByTestId(`transcript-fork-divider-open-parent:${address.sessionId}:opened-session`)).not.toBeNull();
    });

    it('does not borrow a private fork parent identity from another Home with the same Session id', async () => {
        const { ForkDividerRow } = await import('../forkContext/ForkDividerRow');
        const screen = await renderWithSessionTranscriptSource(<ForkDividerRow parentSessionId={address.sessionId}
            childSessionId="opened-session" serverId="home-b" parentCutoffSeqInclusive={1} />,
        createTestSessionTranscriptSource({ sessionId: 'opened-session', navigate: vi.fn() }));
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain(title);
    });

    it('masks Voice target labels and distinctive avatars', async () => {
        const { useVoiceTargetName, VoiceTargetIdentity } = await import('@/components/voice/presence/VoiceTargetIdentity');
        const hook = await renderHook(() => useVoiceTargetName(address));
        expect(hook.getCurrent()).toBe(t('message.provenanceSession'));
        const screen = await renderScreen(<VoiceTargetIdentity address={address} size="pill" avatarOnly />);
        expect(screen.tree.toJSON()).toBeNull();
    });
});
