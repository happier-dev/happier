import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor } from '@happier-dev/protocol';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, type PromptLibraryRowMutationV1, type PromptStackRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { PromptInvocationEntryV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import type { PromptExternalLinkEntryV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import type { PromptAssetWriteDocRequest } from '@happier-dev/protocol/prompts/library/promptAssetsV1';
import { AccountSettingsV2UpdateRequestSchema, type AccountSettingsV2UpdateRequest } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
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
            else if (path === '/v1/account/encryption') data = { mode: 'plain', updatedAt: 0 };
            else if (path === '/v1/account/encryption/currentness') data = { mode: 'plain', version: 0, settingsVersion,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 };
            else if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) data = { status: 'listed', rows: [{ key: 'invocations', revision: 7,
                content: { t: 'plain', v: { key: 'invocations', value: { v: 1, entries } } } },
                ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'invocations').map(key => ({ key,
                    revision: key === 'external-links' ? externalLinkRevision : key === 'coding' ? codingRevision : 1,
                    content: key === 'external-links' && externalLinks !== null
                        ? { t: 'plain', v: { key, value: { v: 1, links: externalLinks } } }
                        : key === 'coding' && codingStack !== null ? { t: 'plain', v: { key, value: codingStack } } : null }))] };
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
    const createDeps = () => factory.createCliActionDeps({ token, credentials, sessionId: 'session', serverId: 'alpha', serverHttpBaseUrl: url });
    const createExportDeps = (externalWrites: PromptAssetWriteDocRequest[], onExternalWrite?: () => void) => {
        // Registered SDK adapters are the external plugin service boundary. All
        // catalog selection, Artifact decoding, export and persistence stay real.
        const adapter: PromptAssetAdapter = {
            descriptor: { id: 'external.prompt', providerId: 'external', title: 'External prompt', description: 'External service',
                libraryKind: 'doc', supportsScope: { user: true, project: false }, supportsFiles: false,
                formatId: 'markdown', defaultRoots: [], capabilities: {} },
            discover: async () => [],
            read: async () => { throw new Error('Unexpected external read'); },
            writeDoc: async request => {
                externalWrites.push(request);
                onExternalWrite?.();
                return { ok: true, externalRef: { id: 'current-external' }, digest: 'exported-digest' };
            },
            writeBundle: async () => { throw new Error('Unexpected bundle export'); },
            delete: async () => { throw new Error('Unexpected external delete'); },
        };
        return factory.createCliActionDeps({ token, credentials, sessionId: 'session', serverId: 'alpha', serverHttpBaseUrl: url,
            readRegisteredPromptAssetAdapters: () => new Map([[adapter.descriptor.id, adapter]]) });
    };
    const exportRequest = { artifactId: 'body', machineId: 'local-machine', assetTypeId: 'external.prompt', scope: 'user' as const,
        targetPath: 'exported.md' };

    it('F8 routes Account stack Actions through the real captured keyless catalog transport and refuses stale edits', async () => {
        const retained = { id: 'skill', ref: { kind: 'bundle' as const, artifactId: 'body' }, enabled: true,
            placement: 'skill_instructions' as const };
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
        expect(listed, JSON.stringify(requests)).toEqual({ items: [], coverage: 'complete' });
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
        expect(await deps.promptInvocationsList?.({})).toMatchObject({ coverage: 'complete', items: [{ id: 'local' }] });
        expect(await deps.promptInvocationResolve?.({ invocationId: 'local', sessionId: null }))
            .toEqual({ status: 'unavailable', invocationId: 'local' });
        expect(requests).not.toContain('/v1/artifacts/body');
    });

    it('exports using the current external-link destination and acknowledges its row CAS without restoring the Settings source', async () => {
        expect((await getServerProfile('alpha')).homeConnectionDescriptor?.homeServerIdentityId).toBe('srv_library_a');
        const selected: PromptExternalLinkEntryV1 = { id: 'current', artifactId: 'body', assetTypeId: 'external.prompt',
            scope: 'user', machineId: 'local-machine', externalRef: { id: 'current-external' },
            lastExternalDigest: 'current-digest' };
        const neighbor: PromptExternalLinkEntryV1 = { ...selected, id: 'neighbor', artifactId: 'neighbor-doc',
            externalRef: { id: 'neighbor-external' }, lastExternalDigest: 'neighbor-digest' };
        const foreign: PromptExternalLinkEntryV1 = { ...selected, id: 'foreign-home', serverIdentityId: 'srv_machine_b',
            externalRef: { id: 'foreign-external' }, lastExternalDigest: 'foreign-digest' };
        externalLinks = [selected, neighbor, foreign];
        rawSettings = { promptExternalLinksV1: { v: 1, links: [{ ...selected, id: 'stale',
            externalRef: { id: 'stale-external' }, lastExternalDigest: 'stale-digest' }] } };
        publish();
        const externalWrites: PromptAssetWriteDocRequest[] = [];
        const deps = createExportDeps(externalWrites);
        if (!deps.promptAssetExport) throw new Error('Missing export Action owner');
        const result = await deps.promptAssetExport(exportRequest);
        expect(externalWrites, JSON.stringify({ result, requests })).toMatchObject([
            { externalRef: { id: 'current-external' }, expectedDigest: 'current-digest' },
        ]);
        expect(result).toMatchObject({ ok: true, exported: true, externalLinkPersistence: { status: 'applied', version: 8 } });
        expect(externalLinkWrites).toHaveLength(1);
        expect(externalLinkWrites[0]).toMatchObject({ expectedRevision: 7,
            content: { t: 'plain', v: { key: 'external-links', value: { v: 1, links: [neighbor, foreign,
                { ...selected, serverIdentityId: 'srv_library_a', lastExternalDigest: 'exported-digest' }] } } } });
        expect(settingsWrites.every(write => write.content?.t !== 'plain'
            || !Object.hasOwn(write.content.v, 'promptExternalLinksV1'))).toBe(true);
    });

    it('refuses an external export before effects when the captured host Home has no observed portable identity', async () => {
        const profile = (await readSettings()).servers?.alpha;
        if (!profile) throw new Error('Missing real host profile fixture');
        await updateSettings(current => {
            const { homeConnectionDescriptor: _removed, ...unobserved } = profile;
            return { ...current, servers: { ...current.servers, alpha: unobserved } };
        });
        try {
            externalLinks = [];
            publish();
            const externalWrites: PromptAssetWriteDocRequest[] = [];
            const result = await createExportDeps(externalWrites).promptAssetExport?.(exportRequest);
            expect(result).toMatchObject({ ok: false, errorCode: 'prompt_catalog_unavailable' });
            expect(externalWrites).toEqual([]);
            expect(externalLinkWrites).toEqual([]);
        } finally {
            await updateSettings(current => ({ ...current, servers: { ...current.servers, alpha: profile } }));
        }
    });

    it('preserves the successful external effect while a competing link row wins the exact CAS', async () => {
        const selected: PromptExternalLinkEntryV1 = { id: 'current', artifactId: 'body', assetTypeId: 'external.prompt',
            scope: 'user', machineId: 'local-machine', externalRef: { id: 'current-external' }, lastExternalDigest: 'current-digest' };
        externalLinks = [selected];
        publish();
        const externalWrites: PromptAssetWriteDocRequest[] = [];
        const winner = { ...selected, lastExternalDigest: 'other-client-digest' };
        const deps = createExportDeps(externalWrites, () => { externalLinks = [winner]; externalLinkRevision = 8; });
        if (!deps.promptAssetExport) throw new Error('Missing export Action owner');
        const result = await deps.promptAssetExport(exportRequest);
        expect(result, JSON.stringify(requests)).toMatchObject({ ok: true, exported: true,
            externalLinkPersistence: { status: 'conflict', currentVersion: 8 } });
        expect(externalWrites).toHaveLength(1);
        expect(externalLinkWrites).toHaveLength(1);
        expect(externalLinkWrites[0]?.expectedRevision).toBe(7);
        expect(externalLinks).toEqual([winner]);
    });

    it.each(['artifact-failure', 'account-retirement'] as const)('retains the observed registry install ACK through the public Action failure envelope after %s', async failure => {
        externalLinks = [];
        artifactCreationFails = failure === 'artifact-failure';
        gitFixture.enabled = true;
        publish();
        const installed = { ok: true as const, externalRef: { id: 'installed-registry-skill' }, digest: 'committed-install-digest' };
        let observedInstalls = 0;
        const adapter: PromptAssetAdapter = {
            descriptor: { id: 'external.skill', providerId: 'external', title: 'External skill', description: 'External service',
                libraryKind: 'bundle', supportsScope: { user: true, project: false }, supportsFiles: true,
                formatId: 'skills.skill_md_v1', defaultRoots: [], capabilities: { supportsCatalogInstall: true } },
            discover: async () => [],
            read: async () => { throw new Error('Unexpected external read'); },
            writeDoc: async () => { throw new Error('Unexpected document install'); },
            writeBundle: async () => {
                observedInstalls += 1;
                if (failure === 'account-retirement') publication.clearActiveAccountSettingsSnapshot();
                return installed;
            },
            delete: async () => { throw new Error('Unexpected external delete'); },
        };
        const deps = factory.createCliActionDeps({ token, credentials, sessionId: 'session', serverId: 'alpha', serverHttpBaseUrl: url,
            readRegisteredPromptAssetAdapters: () => new Map([[adapter.descriptor.id, adapter]]) });
        const result = await createActionExecutor(deps).execute('prompt_registry.install', {
            machineId: 'local-machine', sourceId: 'git:fixture', itemId: 'git:fixture:skill',
            configuredSources: [{ id: 'fixture', adapterId: 'git', title: 'Fixture registry', enabled: true,
                config: { repositoryUrl: 'https://registry-fixture.invalid/source.git' } }],
            installTarget: { assetTypeId: 'external.skill', scope: 'user', targetName: 'installed-skill' },
        // The shipped machine ingress stamps PAT calls as API/Account
        // automation, not terminal CLI (executeExternalAction.ts). Exercise
        // this owner after host approval/policy admission, not surface policy.
        }, { surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' }, bypassApprovals: true });
        expect(observedInstalls, JSON.stringify(result)).toBe(1);
        expect(result).toMatchObject({ ok: false, details: { exported: true, response: installed } });
        expect(JSON.stringify(result)).not.toContain('Private registry title');
        expect(JSON.stringify(result)).not.toContain('Private registry instructions');
        expect(externalLinkWrites).toEqual([]);
        if (failure === 'artifact-failure') expect(requests).toContain('/v1/artifacts');
        else expect(requests).not.toContain('/v1/artifacts');
    });
});
