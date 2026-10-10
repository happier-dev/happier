import { afterEach, describe, expect, it } from 'vitest';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryMutationRequestV1Schema, type AuthoringMemoryReadResponseV1 } from '@happier-dev/protocol/account/authoringMemory';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { storage } from '@/sync/domains/state/storage';
import { resolveUiVoicePromptStackBlocks } from './resolveUiVoicePromptStackBlocks';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readPromptLibraryCatalogProjectionInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { readProfileCatalogProjectionInContext } from '@/sync/api/account/apiProfileCatalog';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';

const entry = (id: string): PromptStackEntryV1 => ({ id, ref: { kind: 'doc', artifactId: id }, enabled: true, placement: 'system_append' });
const readArtifact = async (ref: { artifactId: string }): Promise<PromptLibraryStoredArtifact> => ({ id: ref.artifactId,
    revision: { headerVersion: 1, bodyVersion: 1 }, header: { v: 1, kind: 'prompt_doc.v2', title: ref.artifactId },
    body: JSON.stringify({ v: 1, markdown: ref.artifactId, createdAtMs: 1, updatedAtMs: 1 }) });

describe('qualified UI Voice prompt preparation', () => {
    let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
    afterEach(() => fixture?.dispose());

    it('composes explicit bound four-layer inputs without borrowing ambient Account settings', async () => {
        expect(await resolveUiVoicePromptStackBlocks({ accountEntries: [entry('account')], profileEntries: [entry('profile')],
            projectEntries: [entry('project')], sessionEntries: [entry('session')], readArtifact })).toEqual(['account', 'profile', 'project', 'session']);
    });

    it.each(['destination', 'legacy'] as const)('admits a visible rowless built-in under %s authority and refuses hidden, unknown and disabled selections', async authority => {
        let settingsVersion = 1;
        let rawSettings: Record<string, unknown> = { favoriteProfiles: ['azure-openai'],
            ...(authority === 'legacy' ? { profiles: [] } : {}) };
        let memoryRow: AuthoringMemoryReadResponseV1 = { status: 'present', revision: 1, content: { t: 'plain', v: null } };
        let unreadableInventory = false;
        const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        fixture = await createPlainArtifactHomeFixture(`https://voice-rowless-${authority}.example`, { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const request = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    expect(request.expectedVersion).toBe(settingsVersion);
                    expect(request.content?.t).toBe('plain');
                    if (request.content?.t !== 'plain') throw new Error('Expected plain fixture settings');
                    rawSettings = request.content.v;
                    return response({ success: true, version: ++settingsVersion });
                }
                return response({ version: settingsVersion, content: { t: 'plain', v: rawSettings } });
            }
            if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return response({ status: 'listed', rows:
                PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
                    content: key === 'voice' ? { t: 'plain', v: { key, value: { v: 1, scope: { kind: 'voice' },
                        entries: [entry('account')] } } } : null,
                })) });
            if (path === PROFILE_ROWS_ROUTE_V1) return response({ status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: 'absent', transferControl: { status: 'absent' },
                diagnostics: unreadableInventory ? [{ id: 'unreadable-other-profile', revision: 1, reason: 'invalid-stored-content' }] : [] });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return response({ status: 'ready', revision: 'absent' });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return response((init?.method ?? 'GET') === 'GET'
                ? { status: 'absent' } : { status: 'inventory-incomplete' });
            if (path === `${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`) {
                if (init?.method === 'POST') {
                    const request = AuthoringMemoryMutationRequestV1Schema.parse(JSON.parse(String(init.body)));
                    expect(memoryRow.status).toBe('absent');
                    expect(request.expectedRevision).toBe('absent');
                    if (!request.content) throw new Error('Expected an imported fixture value');
                    memoryRow = { status: 'present', revision: 1, content: request.content };
                    return response({ status: 'updated', revision: 1, cursor: 1 });
                }
                return response(memoryRow);
            }
            return null;
        } });
        const context = await captureLazyActionAccountContext(fixture.home.id);
        const metadata = { profileId: 'azure-openai', work: { promptStack: [entry('session')] } };
        const select = (profileId: string) => storage.setState({ sessions: { ...storage.getState().sessions,
            rowless: createSessionFixture({ id: 'rowless', serverId: context.serverId, metadata: { ...metadata, profileId } }),
        } });
        const input = { targetSessionAddress: { serverId: context.serverId, sessionId: 'rowless' }, accountContext: context };
        try {
            for (const id of ['account', 'session']) await context.createArtifactDocument({ artifactId: id,
                header: { v: 1, kind: 'prompt_doc.v2', title: id },
                body: JSON.stringify({ v: 1, markdown: id, createdAtMs: 1, updatedAtMs: 1 }) });
            const projection = await readProfileCatalogProjectionInContext(context);
            expect(projection).toMatchObject({ source: authority, catalog: { status: 'ready', records: [] } });
            select('azure-openai');
            expect(await resolveUiVoicePromptStackBlocks(input)).toEqual(['account', 'session']);
            expect(fixture.requests.some(request => request.path === `${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`)).toBe(false);
            unreadableInventory = true;
            await expect(resolveUiVoicePromptStackBlocks(input)).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
            unreadableInventory = false;
            rawSettings.favoriteProfiles = [];
            memoryRow = { status: 'present', revision: 2, content: { t: 'plain', v: 'azure-openai' } };
            expect(await resolveUiVoicePromptStackBlocks(input)).toEqual(['account', 'session']);
            memoryRow = { status: 'absent' };
            rawSettings.lastUsedProfile = 'azure-openai';
            expect(await resolveUiVoicePromptStackBlocks(input)).toEqual(['account', 'session']);
            expect(rawSettings).not.toHaveProperty('lastUsedProfile');
            memoryRow = { status: 'deleted', revision: 2 };
            rawSettings.lastUsedProfile = 'azure-openai';
            await expect(resolveUiVoicePromptStackBlocks(input)).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
            expect(memoryRow).toEqual({ status: 'deleted', revision: 2 });
            expect(rawSettings).not.toHaveProperty('lastUsedProfile');
            memoryRow = { status: 'present', revision: 3, content: { t: 'plain', v: 'azure-openai' } };
            for (const id of ['gemini-vertex', 'unknown-profile']) {
                select(id);
                await expect(resolveUiVoicePromptStackBlocks(input)).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
            }
            select('azure-openai');
            rawSettings.profileEnabledById = { 'azure-openai': false };
            await expect(resolveUiVoicePromptStackBlocks(input)).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
        } finally { context.dispose(); }
    });

    it('withdraws partial admitted document facts when the captured Account retires during a failed body read', async () => {
        let retireOnFailure = false;
        let retirementObserved = false;
        const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
            status, headers: { 'content-type': 'application/json' },
        });
        fixture = await createPlainArtifactHomeFixture('https://voice-failed-inventory.example', { handleRequest: async (path, init) => {
            if (path === '/v1/artifacts/private-second' && (init?.method ?? 'GET') === 'GET' && retireOnFailure) {
                retireActiveServerAccountScopeLifetime();
                retirementObserved = true;
                return response({ error: 'unavailable' }, 503);
            }
            if (path === '/v2/account/settings') return response({ version: 1, content: { t: 'plain', v: {} } });
            if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return response({ status: 'listed', rows:
                PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
                    content: key === 'voice' ? { t: 'plain', v: { key, value: { v: 1, scope: { kind: 'voice' },
                        entries: [entry('private-first'), { ...entry('private-second'), required: true }] } } } : null,
                })) });
            return null;
        } });
        const account = await captureLazyActionAccountContext(fixture.home.id);
        try {
            for (const id of ['private-first', 'private-second']) await account.createArtifactDocument({ artifactId: id,
                header: { v: 1, kind: 'prompt_doc.v2', title: id },
                body: JSON.stringify({ v: 1, markdown: `Private ${id} content`, createdAtMs: 1, updatedAtMs: 1 }) });
            fixture.requests.splice(0);
            retireOnFailure = true;
            const error = await resolveUiVoicePromptStackBlocks({ serverId: account.serverId, accountContext: account,
                scope: { serverId: account.serverId, accountId: account.accountId } }).then(() => null, (reason: unknown) => reason);
            expect(fixture.requests).toContainEqual({ path: '/v1/artifacts/private-first', method: 'GET' });
            expect(retirementObserved).toBe(true);
            expect(error).toBeInstanceOf(PromptStackPreparationError);
            expect(error).toMatchObject({ status: 'preparation_pending', reason: 'unavailable', admittedEntries: [] });
        } finally { account.dispose(); }
    });

    it('prepares the exact bound Home Profile Project and Session, suppressing inherited entries and memory before body reads', async () => {
        const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        let serverId = '';
        let heldBody: Promise<void> | undefined;
        let bodyReached: (() => void) | undefined;
        const profile = ProfileRecordV1Schema.parse({ v: 1, id: 'bound-profile', enabled: true,
            promptStack: [entry('profile'), entry('suppressed')], secretBindings: {},
            definition: { kind: 'inline', profile: { v: 2, id: 'bound-profile', name: 'Bound', extraEnvironmentVariables: [],
                defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 } } });
        fixture = await createPlainArtifactHomeFixture('https://bound-voice-stack.example', { handleRequest: async path => {
            if (path === '/v1/artifacts/session' && heldBody) { bodyReached?.(); await heldBody; }
            return path === '/v2/account/settings' ? response({ version: 1, content: { t: 'plain', v: {} } })
                : path === PROMPT_LIBRARY_ROWS_ROUTE_V1 ? response({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                    key, revision: 1, content: key === 'voice' ? { t: 'plain', v: { key, value: { v: 1, scope: { kind: 'voice' }, entries: [entry('account'), entry('memory')] } } } : null,
                })) })
                    : path === PROFILE_ROWS_ROUTE_V1 ? response({ status: 'listed', rows: [{ id: profile.id, revision: 1, content: { t: 'plain', v: profile } }],
                        nextCursor: null, complete: true, referenceGuardRevision: 1, transferControl: { status: 'absent' }, diagnostics: [] })
                        : path === PROFILE_REFERENCE_GUARD_ROUTE_V1 ? response({ status: 'ready', revision: 1 })
                            : path === PROFILE_TRANSFER_ROUTE_V1 ? response({ status: 'absent' })
                                : path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` ? response({ status: 'listed', coverage: 'complete', rows: [
                                    { key: { kind: 'workspace-ref', serverId, id: 'checkout' }, revision: 1, content: { t: 'plain', v: {
                                        key: { kind: 'workspace-ref', serverId, id: 'checkout' }, value: { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
                                    { key: { kind: 'project-organization', serverId, projectKey: 'project' }, revision: 1, content: { t: 'plain', v: {
                                        key: { kind: 'project-organization', serverId, projectKey: 'project' }, value: { promptStack: [entry('project')] } } } },
                                ] }) : null;
        } });
        serverId = fixture.home.id;
        const account = await captureLazyActionAccountContext(serverId);
        try {
            for (const id of ['account', 'profile', 'project', 'session', 'suppressed']) {
                await account.createArtifactDocument({ artifactId: id, header: { v: 1, kind: 'prompt_doc.v2', title: id },
                    body: JSON.stringify({ v: 1, markdown: id, createdAtMs: 1, updatedAtMs: 1 }) });
            }
            await account.createArtifactDocument({ artifactId: 'memory', header: { v: 1, kind: 'memory_doc.v1', title: 'Bound memory' },
                body: JSON.stringify({ v: 1, index: [{ id: 'fact', text: 'Remembered index', createdAtMs: 1, sourceSessionRef: null }],
                    topics: [{ title: 'Detail', summary: 'Topic summary', facts: [{ id: 'deep', text: 'PRIVATE TOPIC DETAIL', createdAtMs: 1, sourceSessionRef: null }] }] }) });
            const metadata = { profileId: profile.id, workspaceId: 'checkout', projectId: 'project', path: '/repo', machineId: 'machine',
                work: { memoryEnabled: false, promptStack: [entry('session')], disabledInheritedEntryIds: ['suppressed'],
                    sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Bound conversational notes' } } };
            storage.setState({ sessions: { ...storage.getState().sessions,
                bound: createSessionFixture({ id: 'bound', serverId, metadata }),
                visible: createSessionFixture({ id: 'visible', serverId, metadata: { work: { promptStack: [entry('wrong-screen')] } } }),
            } });
            fixture.requests.splice(0);
            const input = { targetSessionAddress: { serverId, sessionId: 'bound' }, accountContext: account };
            const blocks = await resolveUiVoicePromptStackBlocks(input);
            expect(blocks.slice(0, 4)).toEqual(['account', 'profile', 'project', 'session']);
            expect(blocks.join('\n')).toContain('Bound conversational notes');
            expect(blocks.join('\n')).not.toContain('wrong-screen');
            expect(blocks.join('\n')).not.toContain('suppressed');
            expect(fixture.requests.some(request => request.path === '/v1/artifacts/memory')).toBe(false);
            storage.setState({ sessions: { ...storage.getState().sessions,
                bound: createSessionFixture({ id: 'bound', serverId, metadata: { ...metadata, work: { ...metadata.work, memoryEnabled: true } } }),
            } });
            const enabled = (await resolveUiVoicePromptStackBlocks(input)).join('\n');
            expect(enabled).toContain('Remembered index');
            expect(enabled).toContain('Topic summary');
            expect(enabled).not.toContain('PRIVATE TOPIC DETAIL');
            // A same-id projection from another Home is not the admitted target.
            storage.setState({ sessions: { ...storage.getState().sessions,
                bound: createSessionFixture({ id: 'bound', serverId: 'another-home', metadata }),
            } });
            await expect(resolveUiVoicePromptStackBlocks(input)).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
            storage.setState({ sessions: { ...storage.getState().sessions,
                bound: createSessionFixture({ id: 'bound', serverId, metadata }),
            } });
            let releaseBody!: () => void;
            heldBody = new Promise(resolve => { releaseBody = resolve; });
            const reached = new Promise<void>(resolve => { bodyReached = resolve; });
            const controller = new AbortController();
            const pending = resolveUiVoicePromptStackBlocks({ ...input, signal: controller.signal });
            const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            await reached;
            controller.abort();
            releaseBody();
            await refused;
            heldBody = undefined;
            expect((await resolveUiVoicePromptStackBlocks(input)).slice(0, 4)).toEqual(['account', 'profile', 'project', 'session']);
        } finally { account.dispose(); }
    });

    it('reads current destination Voice/Profile entries rather than Settings and fails unavailable source admission closed', async () => {
        let selected = 'current-voice';
        let status = 200;
        const rawSettings = { promptStacksV1: { v: 1, surfaces: { voice: [entry('stale-voice')] } } };
        const profile = ProfileRecordV1Schema.parse({ v: 1, id: 'work', enabled: true, promptStack: [entry('current-profile')], secretBindings: {},
            definition: { kind: 'inline', profile: { v: 2, id: 'work', name: 'Work', extraEnvironmentVariables: [],
                defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 } } });
        const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
        fixture = await createPlainArtifactHomeFixture('https://voice-current-catalog.example', { handleRequest: async (path) =>
            path === '/v2/account/settings' ? response({ version: 5, content: { t: 'plain', v: rawSettings } })
                : path === PROMPT_LIBRARY_ROWS_ROUTE_V1 ? response({ status: 'listed', rows: [{ key: 'voice', revision: 2,
                    content: { t: 'plain', v: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [entry(selected)] } } } },
                    // Unrelated domains already have destination tombstones;
                    // this Voice read must not become their first import fixture.
                    ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'voice').map(key => ({ key, revision: 1, content: null }))] }, status)
                    : path === PROFILE_ROWS_ROUTE_V1 ? response({ status: 'listed', rows: [{ id: 'work', revision: 2, content: { t: 'plain', v: profile } }],
                        nextCursor: null, complete: true, referenceGuardRevision: 2, transferControl: { status: 'absent' }, diagnostics: [] })
                        : path === PROFILE_REFERENCE_GUARD_ROUTE_V1 ? response({ status: 'ready', revision: 2 })
                            : path === PROFILE_TRANSFER_ROUTE_V1 ? response({ status: 'absent' })
                    : null });
        storage.setState({ settings: { ...storage.getState().settings, promptStacksV1: { v: 1,
            surfaces: { coding: [], voice: [entry('stale-voice')], profilesById: { work: [entry('stale-profile')] } } } } });
        const context = await captureLazyActionAccountContext(fixture.home.id);
        try {
            const projection = await readPromptLibraryCatalogProjectionInContext(context);
            expect(projection.catalog, JSON.stringify(fixture.requests)).toMatchObject({ status: 'ready' });
        } finally { context.dispose(); }
        const args = { serverId: fixture.home.id, profileId: 'work', readArtifact };
        expect(await resolveUiVoicePromptStackBlocks(args)).toEqual(['current-voice', 'current-profile']);
        selected = 'next-voice';
        expect(await resolveUiVoicePromptStackBlocks(args)).toEqual(['next-voice', 'current-profile']);
        status = 503;
        await expect(resolveUiVoicePromptStackBlocks(args)).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
    });
});
