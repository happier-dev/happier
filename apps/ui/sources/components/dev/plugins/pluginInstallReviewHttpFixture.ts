import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { captureActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';

/** Dev-only HTTP fixture: real Home resolution and approval decoding, no live Artifact writes. */
export async function preparePluginInstallReviewHttpFixture(
    serverId: string,
    artifacts: readonly Extract<DecryptedArtifact, { isDecrypted: true }>[],
    signal: AbortSignal,
): Promise<() => () => void> {
    const context = await captureActionAccountContext(serverId, signal);
    try {
        const { accountMode, encryption } = await context.resolveAccountEncryption();
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => context.accountId, encryptionMode: accountMode });
        for (const artifact of artifacts) {
            const row = createPlainArtifactHttpFixture(artifact, context.accountId);
            if (accountMode === 'e2ee') {
                if (!encryption || !artifact.header) throw new Error('Specimen Account encryption unavailable');
                const key = ArtifactEncryption.generateDataEncryptionKey();
                const codec = new ArtifactEncryption(key);
                row.encryptionMode = 'e2ee';
                row.dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
                row.header = await codec.encryptHeader(artifact.header);
                row.body = await codec.encryptBody({ body: artifact.body ?? null });
            }
            boundary.replaceStoredRow(row);
        }
        const ids = new Set(artifacts.map(artifact => artifact.id));
        return () => {
            const fetch = globalThis.fetch.bind(globalThis);
            setRuntimeFetch((input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input));
                const match = /^\/v1\/artifacts\/([^/]+)(?:\/|$)/.exec(url.pathname);
                const batch = url.pathname === '/v1/artifacts/read' && typeof init?.body === 'string'
                    ? ArtifactReadBatchHttpInputV1Schema.parse(JSON.parse(init.body)) : null;
                const fixtureRead = match && ids.has(decodeURIComponent(match[1]!))
                    || batch && batch.artifactIds.every(id => ids.has(id));
                // The saved web entry and the Home's canonical API address can differ.
                // Only these reserved specimen ids belong to this overlay.
                if (fixtureRead) {
                    const response = boundary.handle(url.pathname, init);
                    if (response) return response;
                }
                return fetch(input, init);
            });
            return resetRuntimeFetch;
        };
    } finally { context.dispose(); }
}
