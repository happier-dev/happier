import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { createDbMaintenanceClient } from '@/storage/prisma';
import { resolveProjectSourcesAccessInTx, type ProjectSourceRow } from './projectSourceService';
import type { ProjectSourceAccessCapture } from './projectSourceReadCapture';

describe('Source page capture cost', () => {
    it('uses one database read while keeping the real Source, Team and Group evaluators', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        const source: ProjectSourceRow = { id: 'source', createdByAccountId: 'owner', revision: 1, name: 'Group Source',
            owner: { kind: 'account', accountId: 'owner' },
            audience: [{ principal: { kind: 'group', teamId: 'team', groupId: 'group' }, level: 'view' }],
            attachments: [], repository: null, defaultRef: null, subdir: null, deletedAt: null,
            createdAt: new Date(0), updatedAt: new Date(0) };
        let reads = 0;
        const snapshot: ProjectSourceAccessCapture = {
            actor: { id: 'actor', status: 'active', homeRole: 'member', publicKey: 'key', encryptionMode: 'plain' },
            sources: [{ ...source, createdAt: source.createdAt.getTime(), updatedAt: source.updatedAt.getTime(), deletedAt: null }],
            teams: [{ id: 'team', name: 'Team', description: null, logo: null, sessionCreationPolicy: 'private_default', reviewCreationPolicy: 'private_default',
                externalSharingPolicy: 'allowed', defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only',
                authenticationPolicy: null, archivedAt: null }],
            memberships: [{ teamId: 'team', membership: { id: 'membership', role: 'member', status: 'active', managedExternally: false } }],
            ownerCounts: [], groups: [{ teamId: 'team', teamGroupId: 'group', groupArchivedAt: null }],
            home: null, providers: [], connections: [], installations: [], hasPasswordCredential: false, identities: [],
        };
        const boundary = await createDbMaintenanceClient('postgres', 'postgresql://test:test@127.0.0.1:1/test');
        // Persistent storage is the system boundary; all domain evaluators run unchanged.
        const captured = boundary.$extends({ query: { $allOperations: async ({ model }) => {
            reads += 1;
            if (model === undefined) return [{ capture: snapshot }];
            if (model === 'ProjectSource') return [source];
            if (model === 'Account') return { id: 'actor', status: 'active', homeRole: 'member' };
            if (model === 'Team') return [{ id: 'team', name: 'Team', description: null, logo: null,
                sessionCreationPolicy: 'members', externalSharingPolicy: 'members', defaultSessionHistoryAccess: 'from_join',
                admissionMode: 'open', authenticationPolicy: null, archivedAt: null, directorySources: [] }];
            if (model === 'TeamMembership') return [{ id: 'membership', teamId: 'team', role: 'member', status: 'active',
                provisionedIdentity: null, identityConnectionManagement: null }];
            if (model === 'TeamGroupMembership') return [{ teamId: 'team', teamGroupId: 'group' }];
            throw new Error(`Unexpected storage read: ${model}`);
        } } });
        try {
            // Prisma extensions retain the real delegates; this fixture replaces their database transport only.
            const admitted = await resolveProjectSourcesAccessInTx(captured as unknown as Tx, 'actor', ['source']);
            expect(admitted.get('source')).toMatchObject({ ok: true, source: { id: 'source' } });
            expect(reads).toBe(1);
            expect(admitted.get('source')).toMatchObject({ ok: true, source: {
                audienceTeams: [{ teamId: 'team', name: 'Team' }],
            } });
        } finally { await boundary.$disconnect(); vi.unstubAllEnvs(); }
    });
});
