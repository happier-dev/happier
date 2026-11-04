import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { reportTemplateAcceptedVersionAfterLaunch } from './reportTemplateAcceptedVersionAfterLaunch';

describe('accepted-version reporting after native launch settlement', () => {
    let server: Server;
    let serverHttpBaseUrl: string;
    let status: number;
    const received: Array<{ path: string; authorization: string | undefined; body: unknown }> = [];
    const ownerMetadata: SessionOwnerMetadataV1 = { v: 1, work: { templateInstance: {
        v: 1, source: { kind: 'artifact', serverId: 'recipient-home', artifactId: 'released-template' },
        acceptedVersion: '1.2.0', acceptedBase: { serverId: 'recipient-home', artifactId: 'private-base' },
        skillIds: {}, mcpServerIds: {}, follow: false,
    } } };
    const requester = () => ({ credentials: { token: 'recipient-account-token', encryption: null }, serverHttpBaseUrl });
    beforeEach(async () => {
        received.length = 0;
        status = 200;
        server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            received.push({ path: request.url ?? '', authorization: request.headers.authorization,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(status === 200 ? { changed: true } : { error: 'artifact_not_found' }));
        });
        await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback HTTP test server');
        serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    });
    afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

    it('reports the loaded accepted instance after successful start with the requester Account, including Stop following', async () => {
        await reportTemplateAcceptedVersionAfterLaunch({ result: { type: 'success', sessionId: 'recipient-copy' },
            requester: requester(), ownerMetadata });
        expect(received).toEqual([{ path: '/v1/artifacts/released-template/access/accepted-version',
            authorization: 'Bearer recipient-account-token', body: {
                artifactId: 'released-template', copyId: 'recipient-copy', acceptedVersion: '1.2.0',
            } }]);
    });

    it('does not report a failed start or borrow daemon authority when requester custody is absent', async () => {
        await reportTemplateAcceptedVersionAfterLaunch({ result: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
            errorMessage: 'visible launch failure' }, requester: requester(), ownerMetadata });
        await reportTemplateAcceptedVersionAfterLaunch({ result: { type: 'success', sessionId: 'recipient-copy' }, ownerMetadata });
        expect(received).toEqual([]);
    });

    it('preserves successful launch when the report is refused, making one best-effort attempt', async () => {
        status = 404;
        await expect(reportTemplateAcceptedVersionAfterLaunch({ result: { type: 'success', sessionId: 'recipient-copy' },
            requester: requester(), ownerMetadata })).resolves.toBeUndefined();
        expect(received).toHaveLength(1);
    });
});
