// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createRepositoryPickerInputHost } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';
import { invokeRepositoryUploadPick } from '@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit')).createModalModuleMock().module);
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('@/hooks/ui/useWebFileDropZone', () => import('@/hooks/ui/useWebFileDropZone.web'));
vi.mock('@/utils/files/webDroppedEntries', () => import('@/utils/files/webDroppedEntries.web'));

describe('Session shared browser DOM picker boundary', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    let restoreLocks = () => {};
    let fixtureIndex = 0;
    beforeAll(async () => {
        const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        restoreLocks = installWebLockManagerMock().restore;
        await prepareSessionFilesViewTestkit();
    });
    afterAll(() => restoreLocks());
    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        const rootPath = `/folder-picker-${++fixtureIndex}`;
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, entries: [], truncated: false };
            if (request.method === RPC_METHODS.STAT_FILE) return { success: true, exists: false };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
    });
    afterEach(async () => { standardCleanup(); await fixture.dispose(); vi.unstubAllGlobals(); });

    async function render() {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const inputs: HTMLInputElement[] = [];
        let screen: Awaited<ReturnType<typeof fixture.render>> | undefined;
        const onOpenFile = () => {};
        const body = (searchQuery: string) => fixture.wrap(<SessionRepositoryTreeBrowserView sessionId="s1" serverId={fixture.scope.serverId} searchQuery={searchQuery} onOpenFile={onOpenFile} />);
        screen = await fixture.render(<SessionRepositoryTreeBrowserView sessionId="s1" serverId={fixture.scope.serverId} searchQuery="" onOpenFile={onOpenFile} />, {
            createNodeMock: element => {
                if (element.props.testID === 'repository-tree-drop-zone') return document.createElement('div');
                const testId = element.props['data-testid'];
                return createRepositoryPickerInputHost(element, inputs,
                    () => screen?.findAllByProps({ 'data-testid': testId })[0]?.props.onChange);
            },
        });
        return { screen, inputs, body };
    }

    it('acquires selected files only through the mounted qualified picker', async () => {
        const { screen, inputs } = await render();
        const input = inputs.find(candidate => !candidate.hasAttribute('webkitdirectory'));
        if (!input) throw new Error('Expected mounted file input');
        expect(await invokeRepositoryUploadPick({ scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
            workspace: fixture.scope, kind: 'files', destinationDir: '' })).toEqual({ status: 'requested' });
        Object.defineProperty(input, 'files', { configurable: true, value: [new File(['source'], 'upload-source.txt')] });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
        await vi.waitFor(() => expect(fixture.requests).toContainEqual(expect.objectContaining({
            targetId: fixture.scope.machineId, method: RPC_METHODS.STAT_FILE,
            payload: { path: `${fixture.scope.rootPath}/upload-source.txt` },
        })));
        expect(screen.findAllByProps({ 'data-testid': 'repository-tree-upload-input-files' })).toHaveLength(1);
    });

    it('keeps directory-selection attributes on the same input across parent rerenders', async () => {
        const { screen, inputs, body } = await render();
        const input = inputs.find(candidate => candidate.hasAttribute('webkitdirectory'));
        if (!input) throw new Error('Expected mounted folder input');
        expect(input.hasAttribute('directory')).toBe(true);
        expect(input.multiple).toBe(true);
        await act(async () => screen.update(body('next')));
        expect(inputs.find(candidate => candidate.hasAttribute('webkitdirectory'))).toBe(input);
        expect(input.hasAttribute('webkitdirectory')).toBe(true);
        expect(input.hasAttribute('directory')).toBe(true);
        expect(input.multiple).toBe(true);
    });
});
