import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
vi.mock('@/config', () => ({ config: { filesPreviewMaxBytes: 10 } }));
await prepareSessionFilesViewTestkit();
const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let statResponse: unknown;
let statFailure: Error | undefined;
beforeEach(async () => {
    statResponse = undefined;
    statFailure = undefined;
    fixture = await createSessionFilesViewFixture({ rootPath: '/work/artifacts', serverIdentityId: 'srv_file_metadata', rpc: request => {
        if (request.method === 'statFile') {
            if (statFailure) throw statFailure;
            return statResponse;
        }
        throw new Error(`Unexpected metadata request: ${request.method}`);
    } });
});
afterEach(async () => { await fixture.dispose(); });
const input = (filePath: string) => ({ scope: fixture.scope,
    filePath, isBinaryContent: filePath === 'opaque.bin', diffMode: 'pending' as const, includeDiff: false });
function expectStatTarget(filePath: string) {
    expect(fixture.requests).toEqual([expect.objectContaining({ method: 'statFile',
        payload: { path: `/work/artifacts/${filePath}` } })]);
}

describe('file metadata acquisition failures', () => {
    it.each(['opaque.bin', 'image.png', 'song.mp3', 'report.pdf', 'clip.mp4'])('does not publish metadata for missing %s', async filePath => {
        statResponse = { success: true, exists: false };
        const result = await refreshWorkspaceFileDetails(input(filePath));
        expect(result.error).toBeTruthy();
        expect(result.fileContent).toBeNull();
        expectStatTarget(filePath);
    });
    it.each(['opaque.bin', 'image.png', 'song.mp3', 'report.pdf', 'clip.mp4'])('preserves the daemon refusal for %s', async filePath => {
        statResponse = { success: false, error: 'permission denied' };
        const result = await refreshWorkspaceFileDetails(input(filePath));
        expect(result.error).toBe('permission denied');
        expect(result.fileContent).toBeNull();
        expectStatTarget(filePath);
    });
    it('surfaces an opaque binary transport failure rather than a successful identity card', async () => {
        statFailure = new Error('machine unavailable');
        const result = await refreshWorkspaceFileDetails(input('opaque.bin'));
        expect(result.error).toBe('machine unavailable');
        expect(result.fileContent).toBeNull();
    });
    it.each([
        { sizeBytes: Number.NaN, modifiedMs: 1 },
        { sizeBytes: -1, modifiedMs: 1 },
        { sizeBytes: 1, modifiedMs: Number.NaN },
    ])('keeps malformed video revision metadata an ordinary read error: %o', async metadata => {
        statResponse = { success: true, exists: true, ...metadata };
        const result = await refreshWorkspaceFileDetails(input('clip.mp4'));
        expect(result.error).toBeTruthy();
        expect(result.fileContent).toBeNull();
        expectStatTarget('clip.mp4');
    });
});
