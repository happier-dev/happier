import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactEditor } from './ArtifactEditor';

describe('ArtifactEditor', () => {
    it('does not expose a text Save that can erase a binary file opened through a direct edit route', async () => {
        await loadSyncSingletonForTests();
        const artifact: DecryptedArtifact = { id: 'binary', title: 'archive.zip', isDecrypted: true,
            header: { kind: 'artifact.legacy', title: 'archive.zip' }, rawHeader: { kind: 'artifact.legacy', title: 'archive.zip' },
            body: { blobId: 'a668646c-dc5f-464d-9e49-285c03698cc9', mime: 'application/zip', sizeBytes: 0, sha256: '0'.repeat(64) },
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        const screen = await renderScreen(<ArtifactEditor artifact={artifact} mode="edit" />);
        expect(screen.findByTestId('artifact-editor:save')).toBeNull();
        expect(screen.findByTestId('artifact:download')).not.toBeNull();
    });
});
