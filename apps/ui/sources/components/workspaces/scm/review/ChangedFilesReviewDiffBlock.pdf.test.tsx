import { createHash } from 'node:crypto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen } from '@/dev/testkit';
import { buildPdfBytes } from '@/dev/testkit/fixtures/pdfFixtures';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { ModalProvider } from '@/modal';
import { t } from '@/text';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';

import { ChangedFilesReviewDiffBlock } from './ChangedFilesReviewDiffBlock';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rpc = vi.hoisted(() => ({ machineScmFileRead: vi.fn() }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// The Machine SCM read RPC is the network boundary; revision reads, the compare model and the row stay real.
vi.mock('@/sync/ops/scm/machineScm', async importOriginal => ({
    ...(await importOriginal<typeof import('@/sync/ops/scm/machineScm')>()),
    machineScmFileRead: rpc.machineScmFileRead,
}));

const scope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
const PATH = 'docs/spec.pdf';

function respondWith(blobPages: Readonly<Record<string, number>>) {
    rpc.machineScmFileRead.mockImplementation(async (_machineId: string, request: { selector: { blobId: string } }) => {
        const bytes = Buffer.from(buildPdfBytes(blobPages[request.selector.blobId]!));
        return { success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') };
    });
}

async function renderPdfReview(file: Readonly<{ changeKind: string; beforeBlobId?: string; afterBlobId?: string }>) {
    const source = createChangedFilesReviewDiffStateSource();
    const diff = `Binary files a/${PATH} and b/${PATH} differ\n`;
    // A captured comparison names the binary change in its patch; the row must not show that text.
    source.setDiffState(PATH, { status: 'loaded', diff, error: null });
    const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: { kind: 'session', sessionId: 's1' },
        repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
            path: PATH, binary: true, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: diff },
            occurrences: [], ...file,
        }] } });
    return renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider>
        <ChangedFilesReviewDiffBlock theme={createThemeFixture()} sessionId="s1" snapshotSignature="sig" filePath={PATH}
            isBinaryContent diffStateSource={source} reviewCommentsEnabled={false} reviewCommentDrafts={[]} evidenceOnly workspaceScope={scope}
            imageCompare={{ kind: 'captured', comparisonId: comparison.id, file: comparison.inventory.files[0]! }} />
    </ModalProvider></InjectedAuthProvider>);
}

describe('ChangedFilesReviewDiffBlock PDF changes', () => {
    beforeEach(() => { rpc.machineScmFileRead.mockReset(); });

    it('names a changed PDF with its size delta and opens either revision, not "Binary file"', async () => {
        respondWith({ before: 1, after: 3 });
        const screen = await renderPdfReview({ changeKind: 'modified', beforeBlobId: 'before', afterBlobId: 'after' });
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toMatch(/\+\d[\d.,]* ?(B|KB|MB)/));
            const text = screen.getTextContent();
            expect(text).not.toContain(t('files.binaryFile'));
            expect(text).toContain('PDF');
            await act(async () => screen.pressByTestId('pdf-change-open-before'));
            await vi.waitFor(() => expect(screen.findByTestId('media-stage-pdf')).toBeTruthy());
        } finally { await screen.unmount(); }
    });

    it('offers only the side that exists for an added or a deleted PDF', async () => {
        respondWith({ before: 2, after: 2 });
        const added = await renderPdfReview({ changeKind: 'added', afterBlobId: 'after' });
        try {
            await vi.waitFor(() => expect(added.findByTestId('pdf-change-open-after')).toBeTruthy());
            expect(added.findByTestId('pdf-change-open-before')).toBeNull();
            expect(added.getTextContent()).toContain(t('hunkReview.imageAdded'));
        } finally { await added.unmount(); }
        const deleted = await renderPdfReview({ changeKind: 'deleted', beforeBlobId: 'before' });
        try {
            await vi.waitFor(() => expect(deleted.findByTestId('pdf-change-open-before')).toBeTruthy());
            expect(deleted.findByTestId('pdf-change-open-after')).toBeNull();
            expect(deleted.getTextContent()).toContain(t('hunkReview.imageDeleted'));
        } finally { await deleted.unmount(); }
    });
});
