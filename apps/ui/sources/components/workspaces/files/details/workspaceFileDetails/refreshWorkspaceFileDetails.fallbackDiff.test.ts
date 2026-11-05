import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fileHashVectors from '../../../../../../../../packages/protocol/src/actions/__fixtures__/fileHashVectors.json';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import {
    cleanupWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';

const machineScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: '',
}));

const workspaceStatFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    exists: true,
    kind: 'file',
    sizeBytes: 1024,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (...args: any[]) => machineScmDiffFileSpy(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: any[]) => workspaceStatFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 1024 * 1024 },
}));

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
const workspaceFileDetailsActionBoundary = getWorkspaceFileDetailsActionBoundary();
// Load the real graph during collection; per-test Account restoration should not own module compilation.
await loadSyncSingletonForTests();

describe('refreshWorkspaceFileDetails (fallback diff)', () => {
    let serverId: string;
    beforeEach(async () => {
        serverId = await prepareWorkspaceFileDetailsActionBoundary();
        workspaceFileDetailsActionBoundary.read.mockReset().mockResolvedValue({
            success: true,
            content: Buffer.from('hello\nworld\n').toString('base64'),
        });
    });
    afterEach(async () => {
        vi.useRealTimers();
        await cleanupWorkspaceFileDetailsActionBoundary();
    });

    it.each(['hello\n', 'hello\u0000world', '\uFFFDlegacy'])('opens opaque bytes as read-only text through the existing read owner: %s', async (text) => {
        const bytes = text.startsWith('\uFFFD') ? Buffer.from([0xff, 0x6c, 0x65, 0x67, 0x61, 0x63, 0x79]) : Buffer.from(text);
        workspaceFileDetailsActionBoundary.read.mockResolvedValue({ success: true, content: bytes.toString('base64') });
        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'opaque.bin',
            diffMode: 'pending', isBinaryContent: true, readAsText: true,
        });
        expect(result.fileContent).toMatchObject({ content: text, isBinary: false, contentHash: null, encoding: { editable: false } });
        expect(result.diffContent).toBe(null);
        expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalled();
    });

    it('loads rename removal evidence in File details through the shared diff request', async () => {
        const patch = 'diff --git a/a.txt b/renamed.txt\n--- a/a.txt\n+++ b/renamed.txt\n@@ -1 +1 @@\n-before\n+after\n';
        machineScmDiffFileSpy.mockImplementationOnce(async (_machine, request: { renamed?: { previousPath: string } }) => ({
            success: true,
            diff: request.renamed?.previousPath === 'a.txt' ? patch : '',
        }));
        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const input = {
            scope: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'renamed.txt',
            diffMode: 'included' as const, fileEntryKind: 'renamed' as const, filePreviousPath: 'a.txt',
        };
        const result = await refreshWorkspaceFileDetails(input);
        expect(result.status).toBe('ready');
        expect(result.diffContent).toBe(patch);
    });

    it('returns a synthesized diff for untracked/added files when backend returns empty diff', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceFileDetailsActionBoundary.read.mockClear();

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId, machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/new.txt',
            diffMode: 'pending',
            fileEntryKind: 'untracked',
        });

        expect(result.status).toBe('ready');
        expect(result.error).toBeNull();
        expect(result.diffContent).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(result.diffContent).toContain('+hello');
        expect(result.diffContent).toContain('+world');
        expect(machineScmDiffFileSpy).toHaveBeenCalledWith(
            'm1',
            {
                cwd: '/repo',
                path: 'src/new.txt',
                area: 'pending',
            },
            { serverId },
        );
    });

    it('returns the sha256 hash for editable text content', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceFileDetailsActionBoundary.read.mockClear();

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId, machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/a.txt',
            diffMode: 'pending',
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        expect(result.fileContent?.contentHash).toBe(createHash('sha256').update('hello\nworld\n').digest('hex'));
    });

    it.each(fileHashVectors)('preserves the raw-byte hash and encoding for $name', async (vector) => {
        workspaceFileDetailsActionBoundary.read.mockResolvedValue({ success: true, content: vector.base64 });
        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'src/a.txt', diffMode: 'pending', includeDiff: false,
        });
        expect(result.fileContent).toMatchObject({
            contentHash: vector.sha256, isBinary: false,
            ...(vector.text === null ? { encoding: { editable: false, reason: 'notUtf8' } }
                : { content: vector.text, encoding: { editable: true, hasBom: vector.name === 'bom', eol: vector.name === 'crlf' ? 'crlf' : 'lf', mixedEol: false } }),
        });
    });

    it('keeps mixed line endings editable and records their dominant style', async () => {
        workspaceFileDetailsActionBoundary.read.mockResolvedValue({ success: true, content: Buffer.from('a\r\nb\nc\r\n').toString('base64') });
        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({ scope: { serverId, machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/a.txt', diffMode: 'pending', includeDiff: false });
        expect(result.fileContent?.encoding).toMatchObject({ editable: true, eol: 'crlf', mixedEol: true });
    });

    it('does not turn a failed refresh into an unsupported write capability', async () => {
        workspaceFileDetailsActionBoundary.read.mockResolvedValue({ success: false, error: 'Machine is unreachable' });
        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({ scope: { serverId, machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/a.txt', diffMode: 'pending', includeDiff: false });
        expect(result).toMatchObject({ error: 'Machine is unreachable', fileContent: null, fileWriteSupported: true });
    });
});
