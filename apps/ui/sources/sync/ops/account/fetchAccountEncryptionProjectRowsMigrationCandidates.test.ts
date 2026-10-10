import { describe, expect, it } from 'vitest';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ProjectAccountRowPayloadV1, ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { fetchAccountEncryptionProjectRowsMigrationCandidates } from './fetchAccountEncryptionProjectRowsMigrationCandidates';
import { buildAccountEncryptionProjectRowsDirective } from './buildAccountEncryptionProjectRowsDirective';

const credentials = { token: 'token', secret: encodeBase64(new Uint8Array(32).fill(31)) };
const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
const randomBytes = (length: number) => new Uint8Array(length).fill(7);
const payloads: ProjectAccountRowPayloadV1[] = [
    { key: { kind: 'workspace-ref', serverId: 'home', id: 'ref' }, value: { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 } },
    { key: { kind: 'relationship-graph' }, value: { relationships: [] } },
    { key: { kind: 'project-organization', serverId: 'home', projectKey: 'project' }, value: { hidden: true, pinned: true } },
];

describe('Project row Account encryption census and reseal', () => {
    it('roundtrips every family without keys in Plain or resurrecting tombstones', async () => {
        let rows: ProjectAccountRowV1[] = payloads.map(payload => ({ key: payload.key, revision: 7, content: { t: 'plain', v: payload } }));
        const tombstone: ProjectAccountRowV1 = { key: { kind: 'workspace-ref', serverId: 'home', id: 'deleted' }, revision: 11, content: null };
        const request = async (path: string, init?: RequestInit) => {
            expect(path).toBe('/v1/account/project-rows/list');
            expect(init?.method).toBe('POST');
            expect(JSON.parse(String(init?.body))).toEqual({});
            return Response.json({ status: 'listed', rows: [...rows, tombstone], coverage: 'complete' });
        };
        for (const sourceMode of ['plain', 'e2ee'] as const) {
            const candidates = await fetchAccountEncryptionProjectRowsMigrationCandidates({
                mode: sourceMode, credentials: sourceMode === 'plain' ? { token: 'token' } : credentials, request,
            });
            expect(candidates.map(row => row.payload)).toEqual(payloads);
            const target = sourceMode === 'plain' ? { mode: 'e2ee' as const, material, randomBytes } : { mode: 'plain' as const };
            const directive = buildAccountEncryptionProjectRowsDirective({ candidates, target });
            expect(directive!.items).toHaveLength(3);
            rows = directive!.items.map(item => ({ key: item.key, revision: item.expectedRevision + 1, content: item.content }));
        }
        expect(rows).toEqual(payloads.map(payload => ({ key: payload.key, revision: 9, content: { t: 'plain', v: payload } })));
        expect(tombstone).toMatchObject({ revision: 11, content: null });
    });

    it('refuses unavailable, incomplete, mixed-mode and misbound rows before a switch', async () => {
        const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material, randomBytes });
        const encrypted = cipher.seal(payloads[0]!);
        for (const result of [
            { status: 'account-mode-mismatch' },
            { status: 'listed', rows: [], coverage: 'partial' },
            { status: 'listed', rows: [{ key: payloads[0]!.key, revision: 7, content: { t: 'plain', v: payloads[0] } }], coverage: 'complete' },
            { status: 'listed', rows: [{ key: { kind: 'workspace-ref', serverId: 'other-home', id: 'ref' }, revision: 7, content: encrypted }], coverage: 'complete' },
        ]) await expect(fetchAccountEncryptionProjectRowsMigrationCandidates({
            mode: 'e2ee', credentials, request: async () => Response.json(result),
        })).rejects.toThrow();
        await expect(fetchAccountEncryptionProjectRowsMigrationCandidates({ mode: 'e2ee', credentials: { token: 'token' },
            request: async () => Response.json({ status: 'listed', rows: [], coverage: 'complete' }),
        })).rejects.toThrow();
    });
});
