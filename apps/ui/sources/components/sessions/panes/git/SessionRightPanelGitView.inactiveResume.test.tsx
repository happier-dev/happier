import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '../sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

import { SessionResumeProvider } from '@/components/sessions/model/SessionResumeContext';
import { useSessionResumeRequestListener } from '@/components/sessions/model/sessionResumeRequests';
const runtime = installSessionPaneRuntimeTestHarness();
function createSnapshot(isRepo = true): ScmWorkingSnapshot {
    return {
        fetchedAt: 1, projectKey: 'm1:/repo',
        repo: { isRepo, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [], worktrees: [] },
        capabilities: createScmCapabilities({ readStatus: true, readLog: true, readDiffFile: true, changeSetModel: 'index' }),
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0, hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    };
}

function seedSession(input: Readonly<{ machineOnline: boolean; path?: string; active?: boolean }>) {
    storage.getState().applySessions([createSessionFixture({
        id: 's1', serverId: runtime.serverId, active: input.active ?? false,
        metadata: { machineId: 'm1', path: input.path ?? '/repo', host: 'test-machine' },
    })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', active: input.machineOnline, activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    storage.getState().applySettingsLocal({ scmGitPaneLayout: 'tabs' });
}
beforeEach(() => seedSession({ machineOnline: true }));
async function render(children?: React.ReactNode) {
    const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
    storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(), runtime.serverId);
    const screen = await renderScreen(<runtime.Wrapper>{children}<SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>);
    await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', active: false, activeAt: Date.now() })], true, { sourceServerId: runtime.serverId }));
    return screen;
}
describe('SessionRightPanelGitView (inactive session resume)', () => {
    it('keeps last-known changes under a paused freshness line and resumes the exact Home', async () => {
        const resume = vi.fn(async () => true);
        const otherHomeResume = vi.fn(async () => true);
        function ResumeListeners() {
            useSessionResumeRequestListener('s1', resume, runtime.serverId);
            useSessionResumeRequestListener('s1', otherHomeResume, 'other-home');
            return null;
        }
        storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(), runtime.serverId);
        const screen = await render(<ResumeListeners />);
        expect(screen.findHostByTestId('session-rightpanel-git-paused')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-unavailable')).toBeNull();
        await screen.pressByTestIdAsync('session-rightpanel-git-paused-action');
        expect(resume).toHaveBeenCalled();
        expect(otherHomeResume).not.toHaveBeenCalled();
    });

    it('uses the enclosing Session resume action for paused recovery', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        const resume = vi.fn(async () => true);
        storage.getState().updateSessionProjectScmSnapshot('s1', createSnapshot(), runtime.serverId);
        const screen = await renderScreen(<runtime.Wrapper><SessionResumeProvider onResumeSession={resume}>
            <SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" />
        </SessionResumeProvider></runtime.Wrapper>);
        await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', active: false, activeAt: Date.now() })], true, { sourceServerId: runtime.serverId }));
        await screen.pressByTestIdAsync('session-rightpanel-git-paused-action');
        expect(resume).toHaveBeenCalled();
    });

    it('falls back to the exact Home resume listener when no provider is mounted', async () => {
        const resume = vi.fn(async () => true);
        function Listener() { useSessionResumeRequestListener('s1', resume, runtime.serverId); return null; }
        const screen = await render(<Listener />);
        await screen.pressByTestIdAsync('session-rightpanel-git-paused-action');
        expect(resume).toHaveBeenCalled();
    });

    it('does not borrow a legacy project path when the exact Home workspace is absent', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        seedSession({ machineOnline: true, path: '' });
        const screen = await renderScreen(<runtime.Wrapper><SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>);
        expect(storage.getState().getProjectForSession('s1', runtime.serverId)).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-loading')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-surface:history')).toBeNull();
    });

    it('shows typed unavailability when the workspace has an RPC target and status fails', async () => {
        seedSession({ machineOnline: true });
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        const screen = await renderScreen(<runtime.Wrapper><SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>);
        await act(async () => storage.getState().updateSessionProjectScmSnapshotError('s1', {
            message: 'RPC method not available', errorCode: 'BACKEND_UNAVAILABLE', at: 1,
        }, runtime.serverId));
        expect(screen.findHostByTestId('session-rightpanel-git-unavailable')).not.toBeNull();
    });
});
