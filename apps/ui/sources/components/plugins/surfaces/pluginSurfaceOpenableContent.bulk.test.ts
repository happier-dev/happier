import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { PluginUiHostApiRequestEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { HARD_OPENABLE_CONTENT_MAX_BYTES_V1, OpenableContentStatResultV1Schema } from '@happier-dev/protocol/plugins/openableContent';
import { matchOpenableContentViewerV1, PluginOpenableContentViewerContributionV1Schema } from '@happier-dev/protocol/plugins/openableContentViewerV1';

import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';

import {
    createPluginSurfaceOpenableContentHandlers,
    createWorkspaceFileOpenableContentBinding,
} from './pluginSurfaceOpenableContent';

describe('plugin surface openable content bulk delivery', () => {
    let boundary: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>> | undefined;
    afterEach(async () => { await boundary?.reset(); });

    it.each(['text', 'binary'] as const)('classifies 300 KiB %s beyond the default read budget and preserves explicit reads', async (contentClass) => {
        const sizeBytes = 300 * 1024;
        const bytes = new Uint8Array(sizeBytes).fill(contentClass === 'text' ? 97 : 0);
        const contentHash = bytesToHex(sha256(bytes));
        boundary = await createWorkspaceFileDownloadHarness({ name: 'large.md', bytes });
        boundary.setStatResponse({ success: true, exists: true, kind: 'file', sizeBytes,
            modifiedMs: 100, changedMs: 100, contentHash });
        const binding = createWorkspaceFileOpenableContentBinding({ target: boundary.scope, filePath: 'notes/large.md' });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        const envelope = (method: string, payload: unknown) => PluginUiHostApiRequestEnvelopeV1Schema.parse({
            version: 1, requestId: `request:${method}`,
            surface: { pluginId: 'acme.viewer', contributionId: 'markdown-viewer', surfaceId: 'surface:viewer',
                placement: 'sessionPane', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
            method, payload,
        });
        const revision = `workspace-file:${sizeBytes}:${contentHash}`;
        const stat = OpenableContentStatResultV1Schema.parse(
            await handlers.statOpenableContent!(envelope('statOpenableContent', { ref: binding.ref })),
        );
        expect(stat).toMatchObject({ status: 'ready', contentClass, sizeBytes, revision });
        if (stat.status !== 'ready') throw new Error('Expected classified openable content');
        // The File page chooser uses this same manifest admission and matcher.
        const viewer = PluginOpenableContentViewerContributionV1Schema.parse({
            id: 'markdown-viewer', destination: 'markdown-view', contentClasses: ['text'], mimeTypes: ['text/markdown'],
        });
        expect(matchOpenableContentViewerV1(viewer, stat) !== null).toBe(contentClass === 'text');
        await handlers.statOpenableContent!(envelope('statOpenableContent', { ref: binding.ref }));
        const downloads = () => boundary!.rpcRequests.filter(call => call.method === 'daemon.filesystem.download');
        expect(downloads()).toHaveLength(1);

        await expect(handlers.readOpenableContent!(envelope('readOpenableContent', { ref: binding.ref, expectedRevision: revision })))
            .resolves.toEqual({ status: 'tooLarge', sizeBytes });
        expect(downloads()).toHaveLength(1);
        await expect(handlers.readOpenableContent!(envelope('readOpenableContent', {
            ref: binding.ref, expectedRevision: revision, maxBytes: sizeBytes,
        }))).resolves.toMatchObject({
            status: 'ready', revision,
            content: contentClass === 'text'
                ? { kind: 'utf8', text: 'a'.repeat(sizeBytes) }
                : { kind: 'base64', base64: 'AAAA'.repeat(sizeBytes / 3) },
        });
        expect(downloads()).toHaveLength(2);
        await expect(handlers.readOpenableContent!(envelope('readOpenableContent', {
            ref: binding.ref, expectedRevision: revision, maxBytes: HARD_OPENABLE_CONTENT_MAX_BYTES_V1 + 1,
        }))).resolves.toMatchObject({ code: 'invalid_payload' });
        expect(downloads()).toHaveLength(2);
    });

    it('uses the caller ceiling above the private inline default and keeps a lower caller ceiling typed', async () => {
        const sizeBytes = 300 * 1024;
        const bytes = new Uint8Array(sizeBytes);
        const contentHash = bytesToHex(sha256(bytes));
        boundary = await createWorkspaceFileDownloadHarness({ name: 'preview.png', bytes });
        boundary.setStatResponse({ success: true, exists: true, kind: 'file', sizeBytes,
            modifiedMs: 100, changedMs: 100, contentHash });
        const binding = createWorkspaceFileOpenableContentBinding({
            target: boundary.scope,
            filePath: 'notes/preview.png',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        const revision = `workspace-file:${sizeBytes}:${contentHash}`;
        const request = (maxBytes: number) => PluginUiHostApiRequestEnvelopeV1Schema.parse({
            version: 1,
            requestId: `read:${maxBytes}`,
            surface: { pluginId: 'acme.viewer', contributionId: 'image-viewer', surfaceId: 'surface:viewer',
                placement: 'sessionPane', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
            method: 'readOpenableContent',
            payload: { ref: binding.ref, expectedRevision: revision, maxBytes },
        });

        await expect(handlers.readOpenableContent!(request(256 * 1024)))
            .resolves.toEqual({ status: 'tooLarge', sizeBytes });
        expect(boundary.rpcRequests.filter(call => call.method === 'daemon.filesystem.download')).toEqual([]);

        await expect(handlers.readOpenableContent!(request(sizeBytes))).resolves.toMatchObject({
            status: 'ready', revision,
            content: { kind: 'base64', base64: 'AAAA'.repeat(sizeBytes / 3) },
        });
        expect(boundary.rpcRequests).toContainEqual(expect.objectContaining({
            method: 'daemon.filesystem.download',
            payload: expect.objectContaining({ input: expect.objectContaining({
                rootPath: boundary.scope.rootPath,
                path: `${boundary.scope.rootPath}/notes/preview.png`,
            }) }),
        }));
    });
});
