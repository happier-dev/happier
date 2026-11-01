import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor } from '@happier-dev/protocol';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, type PromptLibraryRowMutationV1, type PromptStackRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { PromptInvocationEntryV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import type { PromptExternalLinkEntryV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import { AccountSettingsV2UpdateRequestSchema, type AccountSettingsV2UpdateRequest } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { RegistrySourceV1 } from '@happier-dev/protocol/registries';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { readSettings, updateSettings } from '@/persistence';
import { getServerProfile } from '@/server/serverProfiles';
import * as factory from './createCliActionDeps';
import * as scope from '@/settings/accountSettings/accountSettingsScopeKey';
import * as publication from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const gitFixture = vi.hoisted(() => ({ enabled: false }));
// Git is an external process boundary. The real registry source, filesystem,
// frontmatter/bundle readers, install orchestration and Action executor stay active.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
        const argv: unknown = args[1];
        if (gitFixture.enabled && args[0] === 'git' && Array.isArray(argv)
            && argv[0] === 'clone' && argv[3] === 'https://registry-fixture.invalid/source.git'
            && typeof argv[4] === 'string') {
            const directory = join(argv[4], 'skill');
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, 'SKILL.md'), '---\nname: Private registry title\n---\nPrivate registry instructions');
            return '';
        }
        return actual.execFileSync(...args);
    } };
});

// Configure the real Home before static imports initialize Configuration. This
// avoids rebuilding the full Action module graph inside a timed test or hook.
const boundary = await vi.hoisted(async () => {
    const [{ createServer }, { mkdir, writeFile }, { join }, { createTempDir }] = await Promise.all([
        import('node:http'), import('node:fs/promises'), import('node:path'), import('@/testkit/fs/tempDir'),
    ]);
    const taskHome = await createTempDir('happier-invocation-account-');
    vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
    for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_ID', 'HAPPIER_WEBAPP_URL']) vi.stubEnv(key, '');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    let handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> = (_request, response) => {
        response.writeHead(503); response.end();
    };
    const peer = createServer((request, response) => handle(request, response));
    await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
    const address = peer.address();
    if (!address || typeof address === 'string') throw new Error('missing_http_address');
    const url = `http://127.0.0.1:${address.port}`;
    await mkdir(join(taskHome, 'servers', 'alpha'), { recursive: true });
    await writeFile(join(taskHome, 'servers', 'alpha', 'access.key'), JSON.stringify({ token }));
    await writeFile(join(taskHome, 'settings.json'), JSON.stringify({ schemaVersion: 6, activeServerId: 'alpha',
        machineIdByServerId: { alpha: 'local-machine' }, machineIdByServerIdByAccountId: { alpha: { account: 'local-machine' } },
        lastTokenSubByServerId: { alpha: 'account' }, servers: { alpha: {
        id: 'alpha', name: 'Alpha', serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_library_a', canonicalServerUrl: url,
            revision: 1, endpoints: [{ kind: 'https', url }] } } } }));
    return { taskHome, peer, url, token, setHandler: (next: typeof handle) => { handle = next; } };
});

describe('CLI Action prompt catalog admission', () => {
    const { taskHome, peer, url, token } = boundary;
    const credentials = { token, encryption: null };
    let rawSettings: Readonly<Record<string, unknown>>;
    let entries: PromptInvocationEntryV1[];
    let externalLinks: PromptExternalLinkEntryV1[] | null;
    let externalLinkRevision: number;
    let codingStack: PromptStackRecordV1 | null;
    let codingRevision: number;
    let settingsVersion: number;
    let available: boolean;
    let retireDuringBody: boolean;
    let retirementObserved: boolean;
    let artifactCreationFails: boolean;
    let registrySources: Readonly<{ v: 2; disabledSourceIds: string[]; sources: RegistrySourceV1[] }> | null;
    const createdArtifacts = new Map<string, Readonly<Record<string, unknown>>>();
    const requests: string[] = [];
    const externalLinkWrites: PromptLibraryRowMutationV1[] = [];
    const stackWrites: PromptLibraryRowMutationV1[] = [];
    const settingsWrites: AccountSettingsV2UpdateRequest[] = [];

    beforeAll(() => {
        boundary.setHandler(async (request, response) => {
            const path = new URL(request.url ?? '/', 'http://localhost').pathname;
            requests.push(path);
            let data: unknown;
            let status = 200;
            let body = '';
            for await (const chunk of request) body += String(chunk);
            if (request.headers.authorization !== `Bearer ${token}`) { status = 401; data = { error: 'unauthorized' }; }
            else if (!available) { status = 503; data = { error: 'unavailable' }; }
            else if (path === '/v1/account/profile') data = { id: 'account' };
            else if (path === '/v1/account/encryption') data = { mode: 'plain', updatedAt: 0 };
            else if (path === '/v1/account/encryption/currentness') data = { mode: 'plain', version: 0, settingsVersion,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 };
            else if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) data = { status: 'listed', rows: [{ key: 'invocations', revision: 7,
                content: { t: 'plain', v: { key: 'invocations', value: { v: 1, entries } } } },
                ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'invocations').map(key => ({ key,
                    revision: key === 'external-links' ? externalLinkRevision : key === 'coding' ? codingRevision : 1,
                    content: key === 'external-links' && externalLinks !== null
                        ? { t: 'plain', v: { key, value: { v: 1, links: externalLinks } } }
                        : key === 'coding' && codingStack !== null ? { t: 'plain', v: { key, value: codingStack } }
                        : key === 'registry-sources' && registrySources !== null ? { t: 'plain', v: { key, value: registrySources } } : null }))] };
            else if (path === `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/coding` && request.method === 'POST') {
                const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(body));
                stackWrites.push(mutation);
                if (mutation.expectedRevision !== codingRevision) { status = 409; data = { status: 'conflict', revision: codingRevision }; }
                else if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'coding') {
                    status = 400; data = { status: 'invalid-stored-content' };
                } else { codingStack = mutation.content.v.value; data = { status: 'updated', revision: ++codingRevision, cursor: codingRevision }; }
            }
            else if (path === `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/external-links` && request.method === 'POST') {
                const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(body));
                externalLinkWrites.push(mutation);
                if (mutation.expectedRevision !== externalLinkRevision) { status = 409; data = { status: 'conflict', revision: externalLinkRevision }; }
                else if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'external-links') {
                    status = 400; data = { status: 'invalid-stored-content' };
                } else {
                    externalLinks = mutation.content.v.value.links;
                    data = { status: 'updated', revision: ++externalLinkRevision, cursor: externalLinkRevision };
                }
            }
            else if (path === '/v2/account/settings' && request.method === 'POST') {
                const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(body));
                settingsWrites.push(mutation);
                if (mutation.content?.t === 'plain') rawSettings = mutation.content.v;
                data = { success: true, version: ++settingsVersion };
            }
            else if (path === '/v2/account/settings') data = { content: { t: 'plain', v: rawSettings }, version: settingsVersion };
            else if (path === '/v1/artifacts' && request.method === 'POST' && artifactCreationFails) {
                status = 503; data = { error: 'unavailable' };
            }
            else if (path === '/v1/artifacts' && request.method === 'POST') {
                const written: unknown = JSON.parse(body);
                if (!written || typeof written !== 'object' || !('id' in written) || typeof written.id !== 'string') throw new Error('Invalid Artifact fixture write');
                createdArtifacts.set(written.id, { ...written, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                data = { id: written.id, headerVersion: 1, bodyVersion: 1 };
            }
            else if (path === '/v1/artifacts' && request.method === 'GET') data = [...createdArtifacts.values()];
            else if (path.startsWith('/v1/artifacts/') && createdArtifacts.has(path.split('/').at(-1)!)) {
                const id = path.split('/').at(-1)!;
                const stored = createdArtifacts.get(id)!;
                if (request.method === 'POST') {
                    const mutation: unknown = JSON.parse(body);
                    if (!mutation || typeof mutation !== 'object' || !('header' in mutation) || !('body' in mutation)
                        || !('expectedHeaderVersion' in mutation) || !('expectedBodyVersion' in mutation)) throw new Error('Invalid Artifact update');
                    if (mutation.expectedHeaderVersion !== stored.headerVersion || mutation.expectedBodyVersion !== stored.bodyVersion) {
                        data = { success: false, error: 'version-mismatch' };
                    } else {
                        const headerVersion = Number(stored.headerVersion) + 1, bodyVersion = Number(stored.bodyVersion) + 1;
                        createdArtifacts.set(id, { ...stored, header: mutation.header, body: mutation.body, headerVersion, bodyVersion });
                        data = { success: true, headerVersion, bodyVersion };
                    }
                } else data = stored;
            }
            else if (path === '/v1/artifacts/body') {
                if (retireDuringBody) {
                    publication.clearActiveAccountSettingsSnapshot();
                    retirementObserved = true;
                }
                data = { id: 'body', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
                    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Selected' }),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Private retired content', createdAtMs: 1, updatedAtMs: 1 }) }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            } else { status = 404; data = { error: 'not_found' }; }
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(data));
        });
    });
    beforeEach(() => {
        rawSettings = {};
        entries = [];
        externalLinks = null;
        externalLinkRevision = 7;
        codingStack = null;
        codingRevision = 4;
        settingsVersion = 3;
        available = true;
        retireDuringBody = false;
        retirementObserved = false;
        artifactCreationFails = false;
        registrySources = null;
        createdArtifacts.clear();
        gitFixture.enabled = false;
        requests.length = 0;
        externalLinkWrites.length = 0;
        stackWrites.length = 0;
        settingsWrites.length = 0;
    });
    afterEach(() => publication?.clearActiveAccountSettingsSnapshot());
    afterAll(async () => {
        peer?.closeAllConnections();
        if (peer) await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
        vi.unstubAllEnvs();
        if (taskHome) await removeTempDir(taskHome);
    });
    const publish = () => publication.setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
        settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: scope.resolveAccountSettingsScopeKey(credentials) });
    const createDeps = () => factory.createCliActionDeps({ token, credentials, sessionId: 'session', mode: 'plain', ctx: null, serverId: 'alpha', serverHttpBaseUrl: url });
    it.each(['doc', 'bundle'] as const)('persists authenticated %s updates through the real CLI dependency and Artifact transport', async kind => {
        const id = `prompt-${kind}`;
        createdArtifacts.set(id, { id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent({ v: 1, kind: `prompt_${kind}.v2`, title: 'Original',
                ...(kind === 'bundle' ? { bundleSchemaId: 'skills.skill_md_v1' } : {}) }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
                ...(kind === 'doc' ? { markdown: 'old' } : { entries: [{ path: 'SKILL.md', contentBase64: 'b2xk', contentKind: 'utf8' }] }) }) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        publish();
        const deps = createDeps();
        const request = { artifactId: id, title: 'Updated', expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
        const result = kind === 'doc' ? await deps.promptDocUpdate!({ ...request, markdown: 'new' })
            : await deps.promptBundleUpdate!({ ...request, skillMarkdown: 'new' });
        expect(result).toMatchObject({ ok: true, artifactId: id, revision: { headerVersion: 2, bodyVersion: 2 } });
        const stored = createdArtifacts.get(id)!;
        expect(decodePlainArtifactStoredContent(String(stored.header))).toMatchObject({ title: 'Updated' });
        const content = decodePlainArtifactStoredContent(String(stored.body));
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Missing persisted Artifact body');
        expect(JSON.parse(content.body)).toMatchObject(kind === 'doc' ? { markdown: 'new' }
            : { entries: [{ path: 'SKILL.md', contentBase64: 'bmV3', contentKind: 'utf8' }] });
        expect(settingsWrites).toEqual([]);
    });

    it('routes registry installation through the real current source catalog before creating an Artifact', async () => {
        registrySources = { v: 2, disabledSourceIds: [], sources: [] };
        publish();
        const deps = createDeps();
        await expect(deps.promptRegistryInstall!({ machineId: 'local-machine', sourceId: 'missing-source', itemId: 'missing-item' }, { surface: 'cli' }))
            .rejects.toMatchObject({ code: 'invalid_source' });
        expect(requests).toContain(PROMPT_LIBRARY_ROWS_ROUTE_V1);
        expect(createdArtifacts.size).toBe(0);
    });

    it('F8 routes Account stack Actions through the real captured keyless catalog transport and refuses stale edits', async () => {
        const retained = { id: 'instructions', ref: { kind: 'doc' as const, artifactId: 'body' }, enabled: true,
            placement: 'system_append' as const };
        codingStack = { v: 1, scope: { kind: 'coding' }, entries: [retained] };
        publish();
        const executor = createActionExecutor(createDeps());
        const context = { serverId: 'alpha', surface: 'cli' as const, bypassApprovals: true };
        expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: 4,
            intent: { kind: 'set_enabled', entryId: retained.id, enabled: false } }, context))
            .toMatchObject({ ok: true, result: { status: 'updated', revision: 5 } });
        expect(codingStack).toEqual({ v: 1, scope: { kind: 'coding' }, entries: [{ ...retained, enabled: false }] });
        expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: 4,
            intent: { kind: 'detach', entryId: retained.id } }, context))
            .toMatchObject({ ok: true, result: { status: 'conflict', revision: 5 } });
        expect(stackWrites).toHaveLength(1);
        expect(settingsWrites).toEqual([]);
    });

    it('keeps an empty current destination authoritative over the bound retained Settings snapshot', async () => {
        rawSettings = { promptInvocationsV1: { v: 1, entries: [{ id: 'stale', token: '/stale', title: 'Stale',
            target: { kind: 'doc', artifactId: 'stale-doc' }, behavior: 'insert', allowArgs: false, availableIn: 'global' }] } };
        publish();
        const deps = createDeps();
        if (!deps.promptInvocationsList) throw new Error('Missing invocation Action owner');
        const listed = await deps.promptInvocationsList({});
        expect(listed, JSON.stringify(requests)).toEqual({ items: [], coverage: 'complete', revision: 7 });
        available = false;
        expect(await deps.promptInvocationsList({})).toEqual({ items: [], coverage: 'unavailable' });
    });
    it('does not disclose an invocation whose captured Account retires during its body HTTP read', async () => {
        entries = [{ id: 'selected', token: '/selected', title: 'Selected', target: { kind: 'doc', artifactId: 'body' },
            behavior: 'insert', allowArgs: false, availableIn: 'global' }];
        retireDuringBody = true;
        publish();
        const deps = createDeps();
        if (!deps.promptInvocationResolve) throw new Error('Missing invocation Action owner');
        const result = await deps.promptInvocationResolve({ invocationId: 'selected', sessionId: null });
        expect(requests, JSON.stringify(result)).toContain('/v1/artifacts/body');
        expect(retirementObserved).toBe(true);
        expect(result).toEqual({ status: 'unavailable', invocationId: 'selected' });
    });

    it('denies a session-only invocation without loading its Artifact body', async () => {
        entries = [{ id: 'local', token: '/local', title: 'Local', target: { kind: 'doc', artifactId: 'body' },
            behavior: 'insert', allowArgs: false, availableIn: 'session_only' }];
        publish();
        const deps = createDeps();
        expect(await deps.promptInvocationsList?.({})).toMatchObject({ coverage: 'complete', revision: 7,
            items: [{ id: 'local', target: { kind: 'doc', artifactId: 'body' } }] });
        expect(await deps.promptInvocationResolve?.({ invocationId: 'local', sessionId: null }))
            .toEqual({ status: 'unavailable', invocationId: 'local' });
        expect(requests).not.toContain('/v1/artifacts/body');
    });

});
