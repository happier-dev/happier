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
let currentErrorCode = 'BACKEND_UNAVAILABLE';
// Real status refreshes must report the same daemon failure under examination.
vi.mock('socket.io-client', async (importOriginal) => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));
const runtime = installSessionPaneRuntimeTestHarness({ rpc: async () => ({ success: false, errorCode: currentErrorCode, error: 'Internal daemon detail' }) });
beforeEach(() => {
    storage.getState().applySessions([createSessionFixture({
        id: 's1', serverId: runtime.serverId, active: true,
        metadata: { machineId: 'm1', path: '/repo', host: 'test-machine' },
    })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    storage.getState().applySettingsLocal({ scmGitPaneLayout: 'tabs' });
});
async function render() {
    const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
    return renderScreen(<runtime.Wrapper><SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>);
}

describe('SessionRightPanelGitView (snapshot error is typed, never raw)', () => {
    it.each([
        ['BACKEND_UNAVAILABLE', 'RPC method not available', 'errors.sourceControlUnavailableForSession'],
        ['FEATURE_UNSUPPORTED', 'Method not found', 'deps.installNotSupported'],
    ])('renders typed %s recovery without exposing internal detail', async (errorCode, message, expectedKey) => {
        currentErrorCode = errorCode;
        const screen = await render();
        await act(async () => storage.getState().updateSessionProjectScmSnapshotError('s1', { message, errorCode, at: 1 }, runtime.serverId));
        const text = screen.getTextContent();
        expect(text).toContain(expectedKey);
        expect(text).not.toContain(message);
        // Unsupported installations retain generic retry copy alongside the typed detail.
        if (errorCode === 'BACKEND_UNAVAILABLE') expect(text).not.toContain('errors.tryAgain');
    });
});
