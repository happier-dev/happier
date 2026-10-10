import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '../sessionFileNativeTransferTestkit';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
const filePath = 'bin.dat';

beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    standardCleanup();
    transfer = createSessionFileNativeTransferBoundary({ bytes: new Uint8Array([0, 1, 0, 2]), name: filePath });
    fixture = await createSessionFilesViewFixture({
        machineCarrierOrigin: 'http://127.0.0.1:48126',
        request: transfer.request,
        rpc: (request) => request.method === 'statFile'
            ? { success: true, exists: true, kind: 'file', sizeBytes: 4 }
            : request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request),
    });
    fixture.setSnapshot(fileViewSnapshot({ entries: [{
        path: filePath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: true },
    }] }));
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('SessionFileDetailsView (binary)', () => {
    it('keeps the download action available when the workspace scope is available', async () => {
        // A dormant Session still has an exact, reachable Workspace owner.
        fixture.storage.getState().applySessions([{ ...fixture.session, active: false }]);
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FileActionToolbar } = await import('@/components/workspaces/files/file/FileActionToolbar');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        expect(screen.tree.root.findAllByType(FileActionToolbar)).toHaveLength(1);
        expect(screen.findHostByTestId('file-header-download')).not.toBeNull();
    });

    it('renders header actions even when file content is binary', async () => {
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FileActionToolbar } = await import('@/components/workspaces/files/file/FileActionToolbar');
        const { FileBinaryState, FileErrorState } = await import('@/components/workspaces/files/file/FileScreenState');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        const toolbar = screen.tree.root.findAllByType(FileActionToolbar);
        expect(toolbar).toHaveLength(1);
        expect(toolbar[0]!.props.showWrapLinesToggle).toBe(false);
        expect(screen.findAllHostsByTestId('scm-discard-bin.dat')).toHaveLength(1);
        expect(screen.findHostByTestId('file-header-download')).not.toBeNull();
        expect(screen.tree.root.findAllByType(FileBinaryState)).toHaveLength(1);
        expect(fixture.requests.some((request) => request.method === 'statFile')).toBe(true);
        await act(async () => { await screen.pressByTestIdAsync('file-header-download'); });
        expect(fixture.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            targetId: 'm1',
            method: getActionSpec('daemon.filesystem.download').bindings?.rpcMethod,
            payload: expect.objectContaining({ input: expect.objectContaining({ rootPath: '/workspace', path: '/workspace/' + filePath, asZip: false }) }),
        })]));
    });
});
