import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol';

import { registerPlainArtifactRoutes } from './widgetApproval.testkit';

describe('plain Artifact HTTP fixture', () => {
    it('returns the published filtered envelope for exact kinds without including unrelated rows', async () => {
        const app = Fastify();
        const artifacts = registerPlainArtifactRoutes(app, 'account-1');
        artifacts.seed('role', encodePlainArtifactStoredContent({ kind: 'role.v1' }), encodePlainArtifactStoredContent({}));
        artifacts.seed('prompt', encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2' }), encodePlainArtifactStoredContent({}));
        try {
            const exact = await app.inject({ method: 'GET', url: `/v1/artifacts?kinds=${encodeURIComponent(JSON.stringify(['role.v1']))}` });
            expect(exact.statusCode).toBe(200);
            expect(exact.json()).toMatchObject({ items: [{ id: 'role' }], hasUnclassified: false });
            expect(exact.json().items).toHaveLength(1);
            const absent = await app.inject({ method: 'GET', url: '/v1/artifacts?kinds=%5B%5D' });
            expect(absent.json()).toEqual({ items: [], hasUnclassified: false,
                coverage: { status: 'complete', unclassifiedCount: 0 } });
            const coarse = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=prompt' });
            expect(coarse.json()).toMatchObject({ items: [{ id: 'prompt' }], hasUnclassified: false });
            const unfiltered = await app.inject({ method: 'GET', url: '/v1/artifacts' });
            expect(unfiltered.json()).toHaveLength(2);
        } finally {
            await app.close();
        }
    });
});
