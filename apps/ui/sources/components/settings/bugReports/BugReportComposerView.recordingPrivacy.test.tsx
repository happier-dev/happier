import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { BugReportComposerView } = await import('./BugReportComposerView');

afterEach(async () => {
    await standardCleanup();
    const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
    setScreenSharingPrivacyActive(false);
    await account.reset();
    rpc.reset();
});

describe('Bug report selected Session recording privacy', () => {
    it('hides the incidental identifier without discarding the retained report target', async () => {
        const { serverId } = await account.restore({ serverIdentityId: 'srv_bug_privacy', machines: [] });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const sessionId = 'confidential-session-target';
        await React.act(async () => storage.setState({ settings: { ...storage.getState().settings,
            sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } },
        sessionOrganizationTagAssignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey(serverId, sessionId)]: { sessionId, tagIds: ['private'] },
        } }));
        const screen = await renderScreen(<BugReportComposerView initialSessionTarget={{ serverId, sessionId }} />);
        expect(screen.getTextContent()).toContain(sessionId.slice(0, 12));
        await React.act(async () => setScreenSharingPrivacyActive(true));
        expect(screen.getTextContent()).not.toContain(sessionId.slice(0, 12));
        expect(screen.findByTestId('bug-report-remove-session')).not.toBeNull();
        await React.act(async () => setScreenSharingPrivacyActive(false));
        expect(screen.getTextContent()).toContain(sessionId.slice(0, 12));
        await screen.pressByTestIdAsync('bug-report-remove-session');
        expect(screen.findByTestId('bug-report-remove-session')).toBeNull();
        expect(screen.getTextContent()).not.toContain(sessionId.slice(0, 12));
    });
});
