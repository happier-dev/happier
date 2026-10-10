import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS } from '@/voice/registry/generatedBundledVoiceEntries';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

// The Home network, device credentials and disconnected socket are boundaries;
// named Account capture, context semantics and the organization CAS stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { readUiMemoryInheritedContext } = await import('./readUiMemoryInheritedContext');

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { await homes.reset(); });

describe('Project context through the default Account Action host', () => {
    it('refuses a stale workspace mapping as Session Machine authority before selecting Project memory', async () => {
        const serverId = await homes.addHome({ name: 'Machine Authority Home', serverUrl: 'https://machine-authority.test', accountId: 'memory-owner', active: false });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-machine-authority.test', accountId: 'other-owner' });
        const workspaceKey = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
        const projectKey = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
        const memoryEntry = { id: 'project.memory', enabled: true, placement: 'system_append' as const,
            ref: { kind: 'doc' as const, artifactId: 'memory' } };
        let rowMachineId = 'stale-machine';
        let rootPath = '/stale-repo';
        homes.answer(serverId, `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { select: () => ({ body: {
            status: 'listed', coverage: 'complete', rows: [
                { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
                    id: 'checkout', serverId, machineId: rowMachineId, rootPath, projectKey: 'project', createdAtMs: 1,
                } } } },
                { key: projectKey, revision: 1, content: { t: 'plain', v: { key: projectKey, value: { promptStack: [memoryEntry] } } } },
            ],
        } }) });
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const snapshot = { revision: 3, metadata: { machineId: 'actual-machine', workspaceId: 'checkout', projectId: 'project', path: '/agent',
                sessionWorkspaceLocationV1: { v: 1, machineId: 'stale-machine', agentPath: '/agent', machinePath: '/stale-repo' } } };
            await expect(readUiMemoryInheritedContext(account, snapshot, { surface: 'ui' })).rejects.toMatchObject({
                code: 'preparation_pending', reason: 'project_association_unavailable',
            });
            rowMachineId = 'actual-machine';
            rootPath = '/agent';
            await expect(readUiMemoryInheritedContext(account, snapshot, { surface: 'ui' })).resolves.toMatchObject({
                projectEntries: [{ ...memoryEntry, ref: { ...memoryEntry.ref, serverId } }],
            });
        } finally { account.dispose(); }
    });
    it('reads exact Home Project memory and attaches Account memory through the captured coding row without rebasing', async () => {
        const serverId = await homes.addHome({ name: 'Memory Home', serverUrl: 'https://memory-target.test', accountId: 'memory-owner', active: false });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://other-memory-target.test', accountId: 'other-owner' });
        const instruction = { id: 'instructions', ref: { kind: 'doc' as const, artifactId: 'instructions' }, enabled: true, placement: 'system_append' as const };
        const projectMemory = { ...instruction, id: 'project.memory', ref: { kind: 'doc' as const, artifactId: 'project-memory' } };
        let record: Extract<PromptLibraryRecordV1, { key: 'coding' }> = { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [instruction] } };
        let revision = 4;
        const mutations: unknown[] = [];
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(serverId, '/v2/account/settings', { body: { version: 7, content: { t: 'plain', v: {} } } });
        homes.answer(serverId, '/v1/account/entity-rows/prompt-library', { select: () => ({ body: { status: 'listed', rows: [
            { key: 'coding', revision, content: { t: 'plain', v: record } },
            ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'coding').map(key => ({ key, revision: 1, content: null })),
        ] } }) });
        homes.answer(serverId, 'POST /v1/account/entity-rows/prompt-library/coding', { select: input => {
            const mutation = PromptLibraryRowMutationV1Schema.parse(input);
            mutations.push(mutation);
            if (mutation.expectedRevision !== revision) return { status: 409, body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'coding') throw new Error('Expected keyless coding row');
            record = mutation.content.v;
            return { body: { status: 'updated', revision: ++revision, cursor: revision } };
        } });
        const workspaceKey = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
        const projectKey = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
        homes.answer(serverId, `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: { status: 'listed', coverage: 'complete', rows: [
            { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
                id: 'checkout', serverId, machineId: 'actual-machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1,
            } } } },
            { key: projectKey, revision: 2, content: { t: 'plain', v: { key: projectKey, value: { promptStack: [projectMemory] } } } },
        ] } });
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const snapshot = { revision: 3, metadata: { machineId: 'actual-machine', workspaceId: 'checkout', projectId: 'project', path: '/agent',
                sessionWorkspaceLocationV1: { v: 1, machineId: 'actual-machine', agentPath: '/agent', machinePath: '/repo' } } };
            const inherited = await readUiMemoryInheritedContext(account, snapshot, { surface: 'ui' });
            expect(inherited.projectEntries).toEqual([{ ...projectMemory, ref: { ...projectMemory.ref, serverId } }]);
            const inheritedAccount = await inherited.readAccountContext();
            expect(inheritedAccount.accountEntries).toEqual([instruction]);
            const ref = { kind: 'doc' as const, artifactId: 'created', serverId };
            await expect(inheritedAccount.attachAccountMemory(ref)).resolves.toBe(true);
            expect(record.value.entries).toEqual([instruction, { id: 'account.memory', ref, enabled: true, placement: 'system_append' }]);
            await expect(inheritedAccount.attachAccountMemory({ ...ref, artifactId: 'loser' })).resolves.toBe(false);
            expect(mutations).toHaveLength(2);
            await expect(readUiMemoryInheritedContext(account, { ...snapshot, metadata: { ...snapshot.metadata, projectId: 'wrong' } },
                { surface: 'ui' })).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_association_unavailable' });
            expect(homes.requests.filter(request => request.path.includes('/entity-rows/')).every(request => request.serverId === serverId)).toBe(true);
        } finally { account.dispose(); }
    });
    it.each(['realtime', 'local'] as const)('sets and clears a reviewed %s Session voice preference through an offline named Home owner CAS without waking compute', async (kind) => {
        const serverId = await homes.addHome({ name: 'Offline Voice Home', serverUrl: 'https://voice-preference-cas.test', accountId: 'voice-owner', active: false });
        await homes.addHome({ name: 'Visible Home', serverUrl: 'https://visible-voice-home.test', accountId: 'visible-owner' });
        const entry = BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS.find(entry => entry.pluginId === 'happier.voice.openai' && entry.declaration.kind === 'conversation');
        if (!entry) throw new Error('Missing OpenAI declaration');
        const preference = kind === 'local'
            ? { providerContributionId: 'happier.voice.builtin/local-neural', settingFieldPath: 'voiceId', value: 'af_heart' }
            : { providerContributionId: entry.providerId, settingFieldPath: 'voice', value: 'my-private-voice' };
        let row = SessionCurrentProjectionRecordV1Schema.parse({ id: 'session', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 4,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: { memoryEnabled: true } }),
            agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
        });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        const path = '/v2/sessions/session';
        homes.answer(serverId, `GET ${path}`, { select: () => ({ body: { session: row } }) });
        homes.answer(serverId, `GET ${path}?accessProjectionVersion=1`, { select: () => ({ body: { session: row } }) });
        homes.answer(serverId, `PATCH ${path}`, { select: input => {
            const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
            expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
            expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
            expect(patch.ownerMetadata.t).toBe('plain');
            row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
                ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
            return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
        } });
        const executor = createDefaultActionExecutor();
        const { sync } = await import('@/sync/sync');
        for (const [index, attempt] of (['ui', 'voice', 'agent', 'mcp', 'cli'] as const)
            .flatMap(surface => [preference, null].map(value => ({ surface, value }))).entries()) {
            const { surface, value } = attempt;
            const result = await executor.execute('session.voice.preference.set', { sessionId: 'session', serverId, expectedMetadataRevision: 4 + index, preference: value },
                { surface, authority: 'present_user', ...(surface === 'agent' ? { defaultSessionId: 'session' } : {}) });
            expect(result, JSON.stringify({ result, syncCredentialsPresent: Boolean(sync.getCredentials()), requests: homes.requests.map(request => ({ serverId: request.serverId, path: request.path })) }))
                .toMatchObject({ ok: true, result: { ok: true, preference: value, version: 5 + index } });
            expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { memoryEnabled: true } } });
            if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner metadata');
            expect(row.ownerMetadata.v.work?.voicePreference ?? null).toEqual(value);
            expect(JSON.parse(row.metadata)).not.toHaveProperty('work');
        }
        expect(homes.requestsFor(path).filter(request => request.input && typeof request.input === 'object' && 'mode' in request.input).map(request => request.token))
            .toEqual(Array.from({ length: 10 }, () => createAccountTokenForTests('voice-owner')));
        expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    });
    it('rejects arbitrary nonvoice settings through the real Session voice Action before metadata mutation', async () => {
        const serverId = await homes.addHome({ name: 'Voice Home', serverUrl: 'https://voice-preference-actions.test', accountId: 'voice-account' });
        const entry = BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS.find(entry => entry.pluginId === 'happier.voice.openai' && entry.declaration.kind === 'conversation');
        if (!entry) throw new Error('Missing OpenAI declaration');
        const executor = createDefaultActionExecutor();
        const result = await executor.execute('session.voice.preference.set', { sessionId: 'session', serverId, expectedMetadataRevision: 1,
            preference: { providerContributionId: entry.providerId, settingFieldPath: 'model', value: 'other-model' },
        }, { surface: 'ui', authority: 'present_user' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'voice_missing' });
        expect(homes.requests.some(request => request.path.includes('/sessions/'))).toBe(false);
    });
    it('mutates the target Home rather than the focused Home without a caller serverId on every admitted surface', async () => {
        const serverId = await homes.addHome({ name: 'Named Context Home', serverUrl: 'https://named-context-actions.test', accountId: 'named-account', active: false });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-context-actions.test', accountId: 'focused-account' });
        const key = { kind: 'project-organization' as const, serverId, projectKey: 'anchor' };
        let row: ProjectAccountRowV1 = { key, revision: 4, content: { t: 'plain', v: { key, value: {
            hidden: true, pinned: true, promptStack: [{ id: 'entry', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'doc' } }],
        } } } };
        const listPath = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`;
        const mutatePath = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`;
        homes.answer(serverId, listPath, { select: () => ({ body: { status: 'listed', coverage: 'complete', rows: [row] } }) });
        homes.answer(serverId, mutatePath, { select: input => {
            const mutation = ProjectAccountRowMutationRequestV1Schema.parse(input).mutations[0]!;
            expect(mutation.key).toEqual(key);
            expect(mutation.expectedRevision).toBe(row.revision);
            row = { key, revision: row.revision + 1, content: mutation.content };
            return { body: { status: 'updated', rows: [row], cursor: row.revision } };
        } });
        const executor = createDefaultActionExecutor();
        for (const [index, surface] of (['ui', 'voice', 'agent', 'mcp', 'cli'] as const).entries()) {
            expect(await executor.execute('projects.context.update', {
                target: { serverId, projectKey: 'anchor' }, expectedRevision: 4 + index,
                intent: { kind: 'set_budget', entryId: 'entry', maxChars: 100 + index },
            }, { surface, authority: 'present_user' })).toMatchObject({
                ok: true, result: { ok: true, revision: 5 + index, row: { hidden: true, pinned: true, promptStack: [{ id: 'entry', maxChars: 100 + index }] } },
            });
        }
        expect(homes.requestsFor(mutatePath).map(request => ({ serverId: request.serverId, token: request.token })))
            .toEqual(Array.from({ length: 5 }, () => ({ serverId, token: createAccountTokenForTests('named-account') })));
        expect(homes.requests.some(request => request.path.startsWith(PROJECT_ACCOUNT_ROWS_ROUTE_V1) && request.serverId !== serverId)).toBe(false);
    });
});
