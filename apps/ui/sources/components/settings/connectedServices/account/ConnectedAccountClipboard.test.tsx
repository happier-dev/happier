import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const platform = vi.hoisted(() => ({ os: 'ios' }));
const clipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard, getStringAsync: async () => '' }));
vi.mock('expo-file-system', async () => {
    const boundary = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module;
    return { ...boundary, Paths: { ...boundary.Paths, document: 'file:///documents' } };
});
installSettingsViewCommonModuleMocks({
    storage: 'real',
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { get OS() { return platform.os; } },
    }),
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ConnectedAccountDeviceForm } = await import('./ConnectedAccountDeviceForm');
const CODE = 'ABCD-EFGH';
let serverId: string;

async function renderCode() {
    return renderScreen(<ConnectedAccountDeviceForm userCode={CODE} busy={false} onPoll={() => {}} onResume={() => {}} />);
}

beforeEach(async () => {
    platform.os = 'ios';
    clipboard.mockClear();
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
    await homes.reset();
    serverId = await homes.addHome({ name: 'Main', serverUrl: 'https://clipboard-home.example', accountId: 'copy-owner' });
    await homes.selectHomes([serverId]);
});
afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); });

describe('connected account clipboard admission', () => {
    it('honors native clipboard Off for a saved crash and still copies when allowed', async () => {
        const { persistPreRestartBugReportSnapshot } = await import('@/utils/system/preRestartBugReportSnapshot');
        await persistPreRestartBugReportSnapshot({ v: 1, createdAtMs: Date.now(), reason: 'crash', platform: 'ios',
            origin: null, isSecureContext: true, errorDetails: 'Saved crash frame', appLogs: '', userActions: [] });
        const { useBugReportComposerDraftState } = await import('@/components/settings/bugReports/hooks/useBugReportComposerDraftState');
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert');
        const hook = await renderHook(() => useBugReportComposerDraftState({ profile: null, serverUrlDefault: '' }));
        try {
            await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
            await act(async () => hook.getCurrent().copySavedCrash());
            expect(clipboard).not.toHaveBeenCalled();
            expect(alert).toHaveBeenCalledWith('common.error', 'appCrash.copyFailed');
            await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'allowed');
            await act(async () => hook.getCurrent().copySavedCrash());
            expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('Saved crash frame'));
        } finally { alert.mockRestore(); }
    });
    it('refuses native Copy when clipboard.write is Off and keeps Copy feedback uncopied', async () => {
        await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
        const screen = await renderCode();
        await screen.pressByTestIdAsync('connected-account-device:copy');
        expect(clipboard).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('common.copy');
        expect(screen.getTextContent()).not.toContain('common.copied');
    });

    it('asks before native Copy and never persists the copied code in the approval', async () => {
        await homes.requireUiApproval(serverId, 'clipboard.write');
        const screen = await renderCode();
        const copying = screen.pressByTestIdAsync('connected-account-device:copy');
        await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
        const artifact = homes.artifacts(serverId).list()[0]!;
        const body = homes.artifacts(serverId).readPlainBody(artifact.id)!;
        expect(ApprovalRequestV2Schema.parse(JSON.parse(body))).toMatchObject({ actionId: 'clipboard.write', status: 'open' });
        expect(body).not.toContain(CODE);
        expect(clipboard).not.toHaveBeenCalled();
        await expect(decideApprovalAsInbox(serverId, artifact.id, 'approve')).resolves.toMatchObject({ ok: true });
        await copying;
        expect(clipboard).toHaveBeenCalledWith(CODE);
        expect(screen.getTextContent()).toContain('common.copied');
        expect(homes.artifacts(serverId).readPlainBody(artifact.id)).not.toContain(CODE);
    });

    it('keeps web Copy in the user gesture even when native admission is Off', async () => {
        platform.os = 'web';
        await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
        const screen = await renderCode();
        const copying = screen.pressByTestIdAsync('connected-account-device:copy');
        expect(clipboard).toHaveBeenCalledWith(CODE);
        await copying;
        expect(screen.getTextContent()).toContain('common.copied');
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });
});
