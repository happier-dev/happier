import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { AccountApiTokenSummaryV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const tokenId = '11111111-1111-4111-8111-111111111111';
installSettingsViewCommonModuleMocks({ storage: 'real', router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { tokenId } }).module;
} });
installDisconnectedServerSocketBoundary();
const {
    apiTokenReadWireFixture,
    createApiTokenSettingsControllerHarness,
    disposeApiTokenSettingsControllerHarnesses,
} = await import('./apiTokenSettingsControllerTestHarness');

afterEach(async () => {
    await standardCleanup();
    const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
    setScreenSharingPrivacyActive(false);
    await disposeApiTokenSettingsControllerHarnesses();
});

async function seedSessions(serverId: string) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
    const hidden = createSessionFixture({ id: 'private-target', metadata: {
        ...createSessionFixture().metadata!, name: 'Confidential acquisition', path: '/secret/acquisition', machineId: 'private-machine',
    } });
    const ordinary = createSessionFixture({ id: 'ordinary-target', metadata: {
        ...createSessionFixture().metadata!, name: 'Public website',
    } });
    await React.act(async () => {
        storage.getState().applyMachines([createMachineFixture({ id: 'private-machine', metadata: {
            ...createMachineFixture().metadata!, displayName: 'Confidential laptop',
        } })]);
        storage.getState().applySessions([hidden, ordinary]);
        storage.setState({ settings: { ...storage.getState().settings,
            sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } },
        sessionOrganizationTagAssignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey(serverId, hidden.id)]: { sessionId: hidden.id, tagIds: ['private'] },
        } });
    });
}

describe('API token target recording privacy', () => {
    it('omits private candidates, retains generic selected targets and restores their identity after sharing', async () => {
        const harness = await createApiTokenSettingsControllerHarness();
        await seedSessions(harness.scope.serverId);
        const { ApiTokenGrantTargetsPicker } = await import('./grant/ApiTokenGrantEditor');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const changes: string[][] = [];
        const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [] as string[], machines: [] } };
        const screen = await renderScreen(<ApiTokenGrantTargetsPicker value={grant}
            onChange={next => changes.push(next.targets?.sessions ?? [])} />);
        expect(screen.getTextContent()).toContain('Confidential acquisition');
        expect(screen.getTextContent()).toContain('Confidential laptop');
        await React.act(async () => setScreenSharingPrivacyActive(true));
        expect(screen.findByTestId('api-token-grant-session:private-target')).toBeNull();
        expect(screen.getTextContent()).toContain('Public website');
        await screen.update(<ApiTokenGrantTargetsPicker
            value={{ ...grant, targets: { sessions: ['private-target'], machines: [] } }}
            onChange={next => changes.push(next.targets?.sessions ?? [])} />);
        expect(screen.findByTestId('api-token-grant-session:private-target')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Confidential acquisition');
        expect(screen.getTextContent()).not.toContain('/secret/acquisition');
        await screen.pressByTestIdAsync('api-token-grant-session:private-target');
        expect(changes.at(-1)).toEqual([]);
        await React.act(async () => setScreenSharingPrivacyActive(false));
        expect(screen.getTextContent()).toContain('Confidential acquisition');
    });

    it('keeps configured detail targets while hiding their identity and machine context', async () => {
        const token = AccountApiTokenSummaryV1Schema.parse(apiTokenReadWireFixture({ tokenId, label: 'Website integration',
            displayPrefix: 'hap_v1_11111111', createdAt: '2026-09-06T00:00:00.000Z', lastUsedAt: null,
            expiresAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
            grant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['private-target'], machines: [] } },
            parentTokenId: null, activeChildCount: 0, embedConfig: null }));
        const harness = await createApiTokenSettingsControllerHarness({ mode: 'plain', rows: [token] });
        await seedSessions(harness.scope.serverId);
        const { ApiTokenSettingsScope } = await import('./collection/ApiTokenSettingsScope');
        const { ApiTokenDetailScreen } = await import('./ApiTokenDetailScreen');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const screen = await renderScreen(<ApiTokenSettingsScope controller={harness.controller}><ApiTokenDetailScreen /></ApiTokenSettingsScope>);
        await React.act(async () => { await harness.controller.refresh(); });
        expect(screen.getTextContent()).toContain('Confidential acquisition');
        expect(screen.getTextContent()).toContain('Confidential laptop');
        await React.act(async () => setScreenSharingPrivacyActive(true));
        expect(screen.getTextContent()).not.toContain('Confidential acquisition');
        expect(screen.getTextContent()).not.toContain('Confidential laptop');
        expect(screen.getTextContent()).toContain('settings.session');
        expect(harness.controller.getState().tokens[0]?.grant.targets?.sessions).toEqual(['private-target']);
        await React.act(async () => setScreenSharingPrivacyActive(false));
        expect(screen.getTextContent()).toContain('Confidential acquisition');
    });
});
