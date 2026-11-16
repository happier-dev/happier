import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createAccountArtifactStore } from './accountArtifactStore';
import { artifactKindListResponse } from '@/testkit/http/artifactHome';

describe('Account Artifact indexed exact selection', () => {
  it.each(['plain', 'e2ee'] as const)('keeps %s exact reads query-only with partial legacy membership and no unrelated bodies', async mode => {
    const credentials = { token: 'synthetic', encryption: mode === 'plain' ? null
      : { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
      : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    const rows = Array.from({ length: 1201 }, (_, index) => ({
      id: `artifact-${index}`, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
      kind: index < 2 ? (index === 0 ? null : 'other') : 'other',
      ...(index < 2 ? {} : { kindHint: index === 2 ? 'account_notice.v1' : 'ordinary.v1' }),
      header: encode({ kind: index === 0 || index === 2 ? 'account_notice.v1' : 'ordinary.v1' }),
      body: encode({ body: 'content' }), dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
      headerVersion: 1, bodyVersion: 1, seq: index + 1, createdAt: index + 1, updatedAt: index + 1,
    }));
    const queries: URLSearchParams[] = [];
    const labeled: string[] = [];
    const bodyIds: string[] = [];
    const kindWritePaths: string[] = [];
    const home = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const send = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      if (request.method === 'POST') {
        let input = '';
        for await (const chunk of request) input += String(chunk);
        const value: unknown = JSON.parse(input);
        if (url.pathname === '/v1/artifacts/read') {
          const ids: unknown = value && typeof value === 'object' ? Reflect.get(value, 'artifactIds') : null;
          if (!Array.isArray(ids)) throw new Error('missing_ids');
          send({ items: ids.map(id => {
            bodyIds.push(String(id));
            const artifact = rows.find(row => row.id === id);
            return { artifactId: id, ok: true, artifact, recipientCensus: mode === 'plain' ? null
              : ArtifactAccessRecipientCensusResponseV1Schema.parse({ artifactId: id, ownerAccountId: 'owner', access: 'owner',
                encryptionMode: mode, dataEncryptionKey: artifact?.dataEncryptionKey, callerDataEncryptionKey: artifact?.dataEncryptionKey,
                recipients: [] }) };
          }) });
          return;
        }
        const row = rows.find(item => url.pathname === `/v1/artifacts/${item.id}`);
        kindWritePaths.push(url.pathname);
        expect(row).toBeDefined();
        expect(value).toEqual({ kind: row?.id === 'artifact-0' ? 'v1:other:account_notice.v1' : 'v1:other:ordinary.v1', expectedHeaderVersion: 1 });
        if (row) { row.kind = 'other'; Object.assign(row, { kindHint: row.id === 'artifact-0' ? 'account_notice.v1' : 'ordinary.v1', updatedAt: 5000 }); labeled.push(row.id); }
        send({ success: true, headerVersion: 1, bodyVersion: 1 }); return;
      }
      expect(url.pathname).toBe('/v1/artifacts');
      queries.push(url.searchParams);
      const selected = url.searchParams.has('unclassified') ? rows.filter(row => !Object.hasOwn(row, 'kindHint'))
        : url.searchParams.has('kinds') ? rows.filter(row => row.kindHint === 'account_notice.v1') : rows;
      const headers = selected.map(({ body: _body, ...row }) => row);
      const projection = url.searchParams.get('includeBody') === 'true' ? selected : headers;
      if (url.searchParams.get('includeBody') === 'true') bodyIds.push(...selected.map(row => row.id));
      send(url.searchParams.has('unclassified') || url.searchParams.has('kinds')
        ? artifactKindListResponse(projection, { status: 'partial',
          unclassifiedCount: rows.filter(row => !Object.hasOwn(row, 'kindHint')).length,
          reason: 'unclassified_legacy_rows' }) : projection);
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    try {
      const address = home.address();
      if (!address || typeof address === 'string') throw new Error('missing_address');
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const artifacts = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => mode });
        for (let index = 0; index < 2; index++) {
          const result = await artifacts.list({ kinds: ['account_notice.v1'], includeBody: true });
          expect(bodyIds.filter(id => id !== 'artifact-2' && id !== 'artifact-0')).toEqual([]);
          expect(result.coverage).toBe('complete');
          expect(result.kindCoverage).toMatchObject({ status: 'partial', unclassifiedCount: 2 });
          expect(result.items.map(item => item.artifactId)).toEqual(['artifact-2', 'artifact-0']);
          expect(result.items[0]?.body).toBe('content');
        }
      });
      expect(labeled).toEqual([]);
      expect(kindWritePaths).toEqual([]);
      expect(bodyIds).toEqual(['artifact-2', 'artifact-0', 'artifact-2', 'artifact-0']);
      expect(queries.every(query => query.has('kinds') || query.has('unclassified'))).toBe(true);
      expect(queries.every(query => !query.has('includeBody'))).toBe(true);
      expect(queries.filter(query => query.has('unclassified'))).toHaveLength(2);
      expect(queries.filter(query => query.has('kinds')).map(query => JSON.parse(query.get('kinds')!)))
        .toEqual([['account_notice.v1'], ['account_notice.v1']]);
    } finally { await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve())); }
  });
});
