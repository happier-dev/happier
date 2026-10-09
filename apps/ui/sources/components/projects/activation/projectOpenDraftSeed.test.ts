import { describe, expect, it } from 'vitest';
import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createSessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { MMKV } from 'react-native-mmkv';
import { resetServerProfilesRuntimeForTests, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { scopedStorageId } from '@/utils/system/storageScope';
import { seedAndOpenProjectDraft } from './projectOpenDraftSeed';

installFileFindAccountBoundaryMocks('home', 'account');

describe('retained Project Open entrance', () => {
    it('retains the canonical Home for legacy selected and exact-checkout aliases', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'project-open-seed-alias';
        const profile = { id: 'seed-home-profile', serverIdentityId: 'srv_seed_canonical', legacyServerIds: ['seed-home-alias'],
            serverUrl: 'https://seed-home.test', name: 'Seed Home', source: 'manual', createdAt: 1, updatedAt: 1, lastUsedAt: 1 } satisfies ServerProfile;
        new MMKV({ id: scopedStorageId('server-profiles', 'project-open-seed-alias') }).set('server-state-v1',
            JSON.stringify({ activeServerId: profile.id, servers: { [profile.id]: profile } }));
        resetServerProfilesRuntimeForTests();
        installFileFindAccountBoundaryMocks(profile.id, 'account');
        try {
            const values = new Map<string, string>();
            const repository = createSessionDraftRepository({ storage: { getString: key => values.get(key),
                set: (key, value) => values.set(key, value), delete: key => values.delete(key) }, syncEnabled: false,
                cipher: { seal: async () => { throw new Error('Not a network write'); }, open: async () => null },
                randomUUID: () => '00000000-0000-4000-8000-000000000011' });
            const lifetime = captureActiveServerAccountScopeLifetime()!;
            const checkout = { serverId: 'seed-home-alias', workspaceId: 'leaf', machineId: 'machine', rootPath: '/repo' };
            await seedAndOpenProjectDraft({ selection: { serverId: profile.id,
                source: { kind: 'workspace', workspaceId: 'leaf', checkout }, editing: { checkout } }, lifetime, repository,
                randomUUID: () => '00000000-0000-4000-8000-000000000012', navigate: route => {
                    expect(route.params.serverId).toBe(profile.serverIdentityId);
                } });
            expect(repository.getSessionDraftSnapshot(lifetime.scope,
                { kind: 'projectOpen', draftId: '00000000-0000-4000-8000-000000000012' })?.document)
                .toMatchObject({ selection: { value: { serverId: profile.serverIdentityId,
                    source: { checkout: { serverId: profile.serverIdentityId, rootPath: '/repo' } },
                    editing: { checkout: { serverId: profile.serverIdentityId, rootPath: '/repo' } } } } });
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            resetServerProfilesRuntimeForTests();
            installFileFindAccountBoundaryMocks('home', 'account');
        }
    });
    it('persists an unfinished selection before navigation without materializing a checkout', async () => {
        let persisted = false;
        let prepared = false;
        const values = new Map<string, string>();
        const repository = createSessionDraftRepository({ storage: { getString: key => {
            if (!prepared) throw new Error('Storage not prepared');
            return values.get(key);
        }, set: (key, value) => values.set(key, value), prepare: async () => { prepared = true; },
            delete: key => values.delete(key), flush: async () => { persisted = true; } }, syncEnabled: false,
            cipher: { seal: async () => { throw new Error('Not a network write'); }, open: async () => null },
            randomUUID: () => '00000000-0000-4000-8000-000000000011' });
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const routes: unknown[] = [];
        await seedAndOpenProjectDraft({ selection: { serverId: 'home' }, lifetime, repository,
            randomUUID: () => '00000000-0000-4000-8000-000000000010',
            navigate: route => { expect(persisted).toBe(true); routes.push(route); } });
        expect(routes).toEqual([{ pathname: '/projects/open', params: { draftId: '00000000-0000-4000-8000-000000000010', serverId: 'home' } }]);
        expect(repository.getSessionDraftSnapshot(lifetime.scope, { kind: 'projectOpen', draftId: '00000000-0000-4000-8000-000000000010' })?.document)
            .toMatchObject({ target: { kind: 'projectOpen' }, selection: { value: { serverId: 'home' } } });
    });
});
