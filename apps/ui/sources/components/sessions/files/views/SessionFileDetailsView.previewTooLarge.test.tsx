import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '../sessionFileNativeTransferTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
const filePath = 'big.txt';

beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    standardCleanup();
    transfer = createSessionFileNativeTransferBoundary({ bytes: new Uint8Array([65, 66, 67]), name: filePath });
    fixture = await createSessionFilesViewFixture({
        machineCarrierOrigin: 'http://127.0.0.1:48126',
        request: transfer.request,
        rpc: (request) => request.method === 'statFile'
            ? { success: true, exists: true, kind: 'file', sizeBytes: Number.MAX_SAFE_INTEGER }
            : request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request),
    });
    fixture.setSnapshot(fileViewSnapshot({ entries: [{
        path: filePath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: false },
    }] }));
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('SessionFileDetailsView (preview too large)', () => {
    it('keeps the download action available when the workspace scope is available', async () => {
        // A dormant Session still has an exact, reachable Workspace owner.
        fixture.storage.getState().applySessions([{ ...fixture.session, active: false }]);
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FileActionToolbar } = await import('@/components/workspaces/files/file/FileActionToolbar');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        expect(screen.tree.root.findAllByType(FileActionToolbar)).toHaveLength(1);
        expect(screen.tree.root.findByType(FileActionToolbar).props.showWrapLinesToggle).toBe(false);
        expect(screen.findHostByTestId('file-preview-unavailable-banner')).not.toBeNull();
        expect(screen.findHostByTestId('file-header-download')).not.toBeNull();
    });

    it('renders a download action instead of a fatal error state', async () => {
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FileActionToolbar } = await import('@/components/workspaces/files/file/FileActionToolbar');
        const { FileErrorState } = await import('@/components/workspaces/files/file/FileScreenState');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        const toolbar = screen.tree.root.findAllByType(FileActionToolbar);
        expect(toolbar).toHaveLength(1);
        expect(toolbar[0]!.props.showWrapLinesToggle).toBe(false);
        expect(screen.findHostByTestId('file-header-download')).not.toBeNull();
        expect(screen.tree.root.findAllByType(FileErrorState)).toHaveLength(0);
        expect(screen.findHostByTestId('file-preview-unavailable-banner')).not.toBeNull();
        expect(fixture.requests.some((request) => request.method === 'statFile')).toBe(true);
        await act(async () => { await screen.pressByTestIdAsync('file-header-download'); });
        expect(fixture.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            targetId: 'm1',
            method: 'daemon.directTransfer.export.prepare',
            payload: expect.objectContaining({ path: '/workspace/' + filePath, asZip: false }),
        })]));
    });
});
