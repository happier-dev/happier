import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, Script } from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import type { ImmutablePluginGenerationRecord } from '@/plugins/store/registry/generationStore';

import {
    MAX_PLUGIN_RESOURCE_BYTES,
    MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES,
    createStablePluginResourcesOwner,
} from './resources';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fixture(pluginId: string, localId = 'shared', bytes = Buffer.from('hello')) {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-resource-'));
    roots.push(rootPath);
    await mkdir(join(rootPath, 'resources'));
    const relativePath = `resources/${localId}.txt`;
    await writeFile(join(rootPath, relativePath), bytes);
    const contribution: ResolvedResourceContribution = {
        provenance: 'external',
        source: { kind: 'archive' },
        pluginId,
        pluginRootPath: rootPath,
        manifestPath: join(rootPath, '.happier-plugin/plugin.json'),
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'archive', locator: `${pluginId}.tgz`, trustPolicy: 'prompt', installPolicy: 'copy',
        },
        definition: {
            kindVersion: 1,
            id: localId,
            type: 'prompt',
            path: relativePath,
            digest: digest(bytes),
            contentType: 'text/plain',
        },
    };
    const file: ImmutablePluginGenerationRecord['files'][number] = {
        relativePath,
        byteLength: bytes.byteLength,
    };
    return { rootPath, relativePath, contribution, file, bytes };
}

function registry(resources: readonly ResolvedResourceContribution[]): Pick<ResolvedContributionRegistry, 'resources'> {
    return { resources };
}

describe('stable plugin resources owner', () => {
    it('normalizes the initial archive candidate resource set when that fixture declares no resources', async () => {
        const builtIns = resolveBuiltInContributions();
        // The public-handoff archive fixture contributes an Agent but no
        // resources. Candidate construction therefore retains only these
        // first-party declarations, after the runtime replaces each root with
        // its committed immutable-generation root.
        const candidateResources = (builtIns.resources ?? []).map((resource) => {
            if (!resource.pluginId) throw new Error('Expected bundled resource plugin identity');
            return Object.freeze({
                ...resource,
                pluginRootPath: `/candidate-generations/${resource.pluginId}`,
            });
        });

        await expect(createStablePluginResourcesOwner({
            registry: registry(candidateResources),
            generations: new Map([[
                'acme.public-handoff-agent',
                {
                    pluginId: 'acme.public-handoff-agent',
                    immutableGenerationId: 'agent-g',
                    rootPath: '/candidate-generations/acme.public-handoff-agent',
                    files: [],
                },
            ]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_generation_invalid' });
    });

    it('does not require a retired manifest digest from a resolved resource declaration', async () => {
        const resource = resolveBuiltInContributions().resources?.find((candidate) => (
            candidate.pluginId === 'happier.inspector' && candidate.definition.id === 'brand-icon'
        ));
        if (!resource) throw new Error('Expected a bundled resource fixture');
        expect(resource).not.toHaveProperty('manifestDigest');

        await expect(createStablePluginResourcesOwner({
            registry: registry([resource]),
            generations: new Map(),
        })).rejects.toMatchObject({ code: 'plugin_resource_generation_invalid' });
    });

    it('derives a bundled resource digest from its exact declared file when the generation inventory is structural', async () => {
        const resource = resolveBuiltInContributions().resources?.find((candidate) => (
            candidate.pluginId === 'happier.inspector' && candidate.definition.id === 'brand-icon'
        ));
        if (!resource?.pluginId || !resource.pluginRootPath || !resource.definition.path) {
            throw new Error('Expected a bundled packaged resource fixture');
        }
        const rootPath = resource.pluginRootPath;
        const committedResource = { ...resource, pluginRootPath: rootPath };
        const bytes = await readFile(join(rootPath, resource.definition.path));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([committedResource]),
            generations: new Map([[
                resource.pluginId,
                {
                    pluginId: resource.pluginId,
                    immutableGenerationId: 'bundled-structural',
                    rootPath,
                    files: [{
                        relativePath: resource.definition.path,
                        byteLength: bytes.byteLength,
                    }],
                },
            ]]),
        });

        const service = owner.bind({
            pluginId: resource.pluginId,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        expect(service.describe(resource.definition.id)).toMatchObject({
            digest: digest(bytes),
            size: bytes.byteLength,
        });
        await expect(service.read(resource.definition.id)).resolves.toMatchObject({
            digest: digest(bytes),
            bytes: new Uint8Array(bytes),
        });
    });

    it('serves exact local ids from the current immutable generation with plugin isolation', async () => {
        const alpha = await fixture('acme.alpha');
        const beta = await fixture('acme.beta', 'shared', Buffer.from('beta'));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([alpha.contribution, beta.contribution]),
            generations: new Map([
                ['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: alpha.rootPath, files: [alpha.file] }],
                ['acme.beta', { pluginId: 'acme.beta', immutableGenerationId: 'beta-7', rootPath: beta.rootPath, files: [beta.file] }],
            ]),
        });

        const alphaService = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const betaService = owner.bind({
            pluginId: 'acme.beta', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const descriptor = alphaService.describe('shared');
        expect(descriptor).toEqual({
            id: 'shared', kind: 'prompt', contentType: 'text/plain', digest: digest(alpha.bytes), size: 5,
        });
        expect(Object.isFrozen(descriptor)).toBe(true);
        const firstRead = await alphaService.read('shared');
        expect(Object.isFrozen(firstRead)).toBe(true);
        firstRead.bytes[0] = 'X'.charCodeAt(0);
        expect(Buffer.from((await alphaService.read('shared')).bytes).toString()).toBe('hello');
        expect(Buffer.from((await betaService.read('shared')).bytes).toString()).toBe('beta');
        expect(() => alphaService.describe('acme.beta/shared')).toThrowError(expect.objectContaining({ code: 'plugin_resource_not_found' }));
        expect(() => alphaService.describe('__proto__')).toThrowError(expect.objectContaining({ code: 'plugin_resource_not_found' }));
    });

    it('binds and retires resource access by each exact immutable contribution generation', async () => {
        const alpha = await fixture('acme.alpha');
        const beta = await fixture('acme.beta');
        const owner = await createStablePluginResourcesOwner({
            registry: { resources: [alpha.contribution, beta.contribution] },
            generations: new Map([
                ['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: alpha.rootPath, files: [alpha.file] }],
                ['acme.beta', { pluginId: 'acme.beta', immutableGenerationId: 'beta-7', rootPath: beta.rootPath, files: [beta.file] }],
            ]),
        });

        const alphaService = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const betaService = owner.bind({
            pluginId: 'acme.beta', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        owner.retirePlugin('acme.alpha');
        expect(() => alphaService.describe('shared')).toThrowError(expect.objectContaining({ code: 'plugin_generation_stale' }));
        expect(Buffer.from((await betaService.read('shared')).bytes)).toEqual(beta.bytes);
    });

    it('accepts the measured official SDK closure admitted by the immutable generation owner', async () => {
        const value = await fixture('acme.sdk-closure');
        const files: ImmutablePluginGenerationRecord['files'] = [
            value.file,
            ...Array.from({ length: 6_355 }, (_, index) => ({
                relativePath: `node_modules/sdk/file-${String(index).padStart(4, '0')}.js`,
                byteLength: 0,
            })),
        ];

        const owner = await createStablePluginResourcesOwner({
            registry: registry([value.contribution]),
            generations: new Map([['acme.sdk-closure', {
                pluginId: 'acme.sdk-closure',
                immutableGenerationId: 'sdk-closure-1',
                rootPath: value.rootPath,
                files,
            }]]),
        });

        expect(owner.hasPlugin('acme.sdk-closure')).toBe(true);
    });

    it('enforces exact and plus-one per-call bounds and the global admission bound', async () => {
        const exact = await fixture('acme.alpha');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([exact.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: exact.rootPath, files: [exact.file] }]]),
        });
        const service = owner.bind({ pluginId: 'acme.alpha', signal: new AbortController().signal, isGenerationCurrent: () => true });

        expect(Buffer.from((await service.read('shared', { maxBytes: exact.bytes.byteLength })).bytes)).toEqual(exact.bytes);
        await expect(service.read('shared', { maxBytes: exact.bytes.byteLength - 1 })).rejects.toMatchObject({ code: 'plugin_resource_too_large' });
        await expect(service.read('shared', { maxBytes: -1 })).rejects.toMatchObject({ code: 'plugin_resource_limit_invalid' });

        const empty = await fixture('acme.empty', 'empty', Buffer.alloc(0));
        const emptyOwner = await createStablePluginResourcesOwner({
            registry: registry([empty.contribution]),
            generations: new Map([['acme.empty', {
                pluginId: 'acme.empty', immutableGenerationId: 'empty-1', rootPath: empty.rootPath, files: [empty.file],
            }]]),
        });
        const emptyService = emptyOwner.bind({
            pluginId: 'acme.empty', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        await expect(emptyService.read('empty', { maxBytes: 0 })).resolves.toMatchObject({ bytes: new Uint8Array() });

        const oversized = await fixture('acme.oversized', 'large', Buffer.alloc(1));
        await truncate(
            join(oversized.rootPath, oversized.relativePath),
            MAX_PLUGIN_RESOURCE_BYTES + 1,
        );
        await expect(createStablePluginResourcesOwner({
            registry: registry([{
                ...oversized.contribution,
                definition: {
                    ...oversized.contribution.definition,
                    digest: undefined,
                },
            }]),
            generations: new Map([['acme.oversized', {
                pluginId: 'acme.oversized', immutableGenerationId: 'oversized-8', rootPath: oversized.rootPath,
                files: [{ ...oversized.file, byteLength: MAX_PLUGIN_RESOURCE_BYTES + 1 }],
            }]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_capacity_exceeded' });

        const aggregateContributions: ResolvedResourceContribution[] = [];
        const aggregateGenerations = new Map<string, { pluginId: string; immutableGenerationId: string; rootPath: string; files: ImmutablePluginGenerationRecord['files'] }>();
        for (let index = 0; index <= MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES / MAX_PLUGIN_RESOURCE_BYTES; index += 1) {
            const item = await fixture(`acme.aggregate-${index}`, `item-${index}`, Buffer.from('x'));
            await truncate(join(item.rootPath, item.relativePath), MAX_PLUGIN_RESOURCE_BYTES);
            aggregateContributions.push({
                ...item.contribution,
                definition: { ...item.contribution.definition, digest: undefined },
            });
            aggregateGenerations.set(`acme.aggregate-${index}`, {
                pluginId: `acme.aggregate-${index}`, immutableGenerationId: `aggregate-${index}`, rootPath: item.rootPath,
                files: [{ ...item.file, byteLength: MAX_PLUGIN_RESOURCE_BYTES }],
            });
        }
        await expect(createStablePluginResourcesOwner({
            registry: registry(aggregateContributions),
            generations: aggregateGenerations,
        })).rejects.toMatchObject({ code: 'plugin_resource_capacity_exceeded' });
    });

    it('rechecks containment, declared file identity, size, and digest on every read', async () => {
        const value = await fixture('acme.alpha');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([value.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        });
        const service = owner.bind({ pluginId: 'acme.alpha', signal: new AbortController().signal, isGenerationCurrent: () => true });

        await writeFile(join(value.rootPath, value.relativePath), 'HELLO');
        await expect(service.read('shared')).rejects.toMatchObject({ code: 'plugin_resource_integrity_mismatch' });
        await writeFile(join(value.rootPath, value.relativePath), 'longer');
        await expect(service.read('shared')).rejects.toMatchObject({ code: 'plugin_resource_integrity_mismatch' });
    });

    it('rejects traversal, missing files, undeclared file paths, and symlink escapes with sanitized codes', async () => {
        const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-resource-outside-'));
        roots.push(outsideRoot);
        const outsidePath = join(outsideRoot, 'outside.txt');
        await writeFile(outsidePath, 'outside');

        for (const [name, path, expectedCode] of [
            ['traversal', '../outside.txt', 'plugin_resource_path_denied'],
            ['missing', 'resources/missing.txt', 'plugin_resource_missing'],
            ['undeclared', 'resources/other.txt', 'plugin_resource_file_not_declared'],
        ] as const) {
            const value = await fixture(`acme.${name}`, name);
            if (name === 'missing') await rm(join(value.rootPath, path));
            if (name === 'undeclared') await writeFile(join(value.rootPath, path), 'present');
            const contribution = { ...value.contribution, definition: { ...value.contribution.definition, path } };
            await expect(createStablePluginResourcesOwner({
                registry: registry([contribution]),
                generations: new Map([[`acme.${name}`, { pluginId: `acme.${name}`, immutableGenerationId: `${name}-1`, rootPath: value.rootPath, files: [value.file] }]]),
            })).rejects.toMatchObject({ code: expectedCode });
        }

        const linked = await fixture('acme.linked');
        await rm(join(linked.rootPath, linked.relativePath));
        await symlink(outsidePath, join(linked.rootPath, linked.relativePath));
        await expect(createStablePluginResourcesOwner({
            registry: registry([linked.contribution]),
            generations: new Map([['acme.linked', { pluginId: 'acme.linked', immutableGenerationId: 'linked-1', rootPath: linked.rootPath, files: [linked.file] }]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_path_denied' });
    });

    it('fences aborts and retired generations before and after asynchronous admission', async () => {
        const value = await fixture('acme.alpha');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([value.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        });
        let current = true;
        const parent = new AbortController();
        const service = owner.bind({ pluginId: 'acme.alpha', signal: parent.signal, isGenerationCurrent: () => current });
        const call = new AbortController();
        call.abort();
        await expect(service.read('shared', { signal: call.signal })).rejects.toMatchObject({ code: 'plugin_resource_aborted' });
        current = false;
        expect(() => service.describe('shared')).toThrowError(expect.objectContaining({ code: 'plugin_generation_stale' }));
        await expect(service.read('shared')).rejects.toMatchObject({ code: 'plugin_generation_stale' });

        current = true;
        await expect(service.read('shared')).resolves.toMatchObject({ digest: digest(value.bytes) });
        owner.retirePlugin('acme.alpha');
        expect(() => service.describe('shared')).toThrowError(expect.objectContaining({ code: 'plugin_generation_stale' }));
    });

    it('rechecks durable committed-generation currentness before serving bytes', async () => {
        const value = await fixture('acme.alpha');
        let committedGenerationCurrent = true;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([value.contribution]),
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file],
            }]]),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        await expect(service.read('shared')).resolves.toMatchObject({ digest: digest(value.bytes) });
        committedGenerationCurrent = false;
        await expect(service.read('shared')).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    });

    it('rejects a generation record keyed under a different plugin identity', async () => {
        const value = await fixture('acme.alpha');

        await expect(createStablePluginResourcesOwner({
            registry: registry([value.contribution]),
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.beta',
                immutableGenerationId: 'beta-7',
                rootPath: value.rootPath,
                files: [value.file],
            }]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_generation_invalid' });
    });

    it('rejects hostile read options without invoking or leaking accessors', async () => {
        const value = await fixture('acme.alpha');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([value.contribution]),
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.alpha',
                immutableGenerationId: 'alpha-7',
                rootPath: value.rootPath,
                files: [value.file],
            }]]),
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        });
        const hostile = Object.create(null) as { maxBytes?: number };
        Object.defineProperty(hostile, 'maxBytes', {
            enumerable: true,
            get: () => { throw new Error('SECRET OPTION GETTER TEXT'); },
        });

        await expect(service.read('shared', hostile)).rejects.toMatchObject({
            code: 'plugin_resource_options_invalid',
            message: expect.not.stringContaining('SECRET'),
        });
    });

    it('reports packaged watch as typed unavailable and rejects hostile declarations without leaking getter text', async () => {
        const value = await fixture('acme.alpha');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([value.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        });
        const service = owner.bind({ pluginId: 'acme.alpha', signal: new AbortController().signal, isGenerationCurrent: () => true });
        expect(() => service.watch('shared', () => {})).toThrowError(expect.objectContaining({ code: 'plugin_resource_watch_unavailable' }));

        const hostile = Object.create(null) as ResolvedResourceContribution;
        Object.defineProperty(hostile, 'pluginId', { enumerable: true, get: () => { throw new Error('SECRET GETTER TEXT'); } });
        await expect(createStablePluginResourcesOwner({
            registry: registry([hostile]),
            generations: new Map(),
        })).rejects.toMatchObject({ code: 'plugin_resource_declaration_invalid', message: expect.not.stringContaining('SECRET') });

        const inherited = Object.assign(Object.create({ inherited: true }), value.contribution) as ResolvedResourceContribution;
        await expect(createStablePluginResourcesOwner({
            registry: registry([inherited]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_declaration_invalid' });
    });
});

describe('dynamic plugin resources (EU-4b §3.6.1)', () => {
    function dynamicContribution(pluginId: string, localId: string): ResolvedResourceContribution {
        return {
            provenance: 'external',
            source: { kind: 'archive' },
            pluginId,
            pluginRootPath: '/tmp/does-not-matter',
            manifestPath: '/tmp/does-not-matter/.happier-plugin/plugin.json',
            daemonEntryPath: null,
            sourceSpec: {
                kind: 'archive', locator: `${pluginId}.tgz`, trustPolicy: 'prompt', installPolicy: 'copy',
            },
            definition: {
                kindVersion: 1,
                id: localId,
                type: 'config',
                source: 'dynamic',
                contentType: 'application/json',
            },
        };
    }

    it('derives only readable/dynamic capability facts from the admitted registry', async () => {
        const packaged = await fixture('acme.alpha', 'packaged');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                packaged.contribution,
                dynamicContribution('acme.alpha', 'live'),
            ]),
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.alpha',
                immutableGenerationId: 'alpha-9',
                rootPath: packaged.rootPath,
                files: [packaged.file],
            }]]),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-9']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(Buffer.from('{"live":true}')),
                    observe: () => ({ dispose: () => {} }),
                },
            }],
        });
        const capability = owner.getPluginUiResourceCapability('acme.alpha');

        expect(capability).toEqual({ readable: true, dynamic: true });
        expect(Object.keys(capability).sort()).toEqual(['dynamic', 'readable']);
        expect(owner.getPluginUiResourceCapability('acme.other')).toEqual({
            readable: false,
            dynamic: false,
        });
        owner.retirePlugin('acme.alpha');
        expect(owner.getPluginUiResourceCapability('acme.alpha')).toEqual({
            readable: false,
            dynamic: false,
        });
    });

    it('keeps a packaged-only selected plugin readable without advertising a watch', async () => {
        const packaged = await fixture('acme.packaged-only', 'guide');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([packaged.contribution]),
            generations: new Map([['acme.packaged-only', {
                pluginId: 'acme.packaged-only',
                immutableGenerationId: 'packaged-only-1',
                rootPath: packaged.rootPath,
                files: [packaged.file],
            }]]),
        });

        // This is a mount-level fact only. The owner intentionally does not
        // disclose its exact local-id inventory here; it continues to resolve
        // and admit each call against that private canonical inventory.
        expect(owner.getPluginUiResourceCapability('acme.packaged-only')).toEqual({
            readable: true,
            dynamic: false,
        });
    });

    it('reads a dynamic resource from its registered producer and invalidates on a real change', async () => {
        let current = Buffer.from('{"count":1}');
        let invalidate: (() => void) | null = null;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-dynamic-9']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(current),
                    observe: (notify: () => void) => {
                        invalidate = notify;
                        return { dispose: () => { invalidate = null; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const first = await service.read('live');
        expect(Buffer.from(first.bytes).toString('utf8')).toBe('{"count":1}');
        expect(first.digest).toBe(digest(Buffer.from('{"count":1}')));

        const changes: { digest: string }[] = [];
        const subscription = service.watch('live', (change) => { changes.push(change); });
        expect(invalidate).toBeTypeOf('function');

        current = Buffer.from('{"count":2}');
        invalidate!();
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(changes).toEqual([{ digest: digest(Buffer.from('{"count":2}')) }]);
        const second = await service.read('live');
        expect(Buffer.from(second.bytes).toString('utf8')).toBe('{"count":2}');

        subscription.dispose();
        expect(invalidate).toBeNull();
    });

    it('accepts cross-realm Uint8Array dynamic resource bytes and rejects other views', async () => {
        const realmBytes = new Script('new Uint8Array([7, 8, 9])').runInContext(createContext({})) as Uint8Array;
        let produced: unknown = realmBytes;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-dynamic-9']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => produced,
                    observe: () => ({ dispose: () => {} }),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        await expect(service.read('live')).resolves.toMatchObject({ bytes: new Uint8Array([7, 8, 9]) });

        produced = new Int8Array([7, 8, 9]);
        await expect(service.read('live')).rejects.toMatchObject({ code: 'plugin_resource_producer_invalid' });
    });

    it('suppresses an invalidation whose bytes did not actually change', async () => {
        // Discriminating control against "just forward every producer notify":
        // that implementation would flood the observer with re-reads of bytes
        // it already has.
        const bytes = Buffer.from('stable');
        let invalidate: (() => void) | null = null;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-dynamic-9']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(bytes),
                    observe: (notify: () => void) => {
                        invalidate = notify;
                        return { dispose: () => { invalidate = null; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: { digest: string }[] = [];
        service.watch('live', (change) => { changes.push(change); });
        invalidate!();
        invalidate!();
        invalidate!();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(changes).toEqual([]);
    });

    it('marks the LKG stale once, then converges after one transient settlement failure without a second signal', async () => {
        // A dynamic producer is level-triggered, but one accepted wakeup still
        // has to converge. The first failed settlement must first wake the
        // generic digest-only consumer with A so it becomes stale, then the
        // owner-local retry can recover to B without another producer signal.
        let current = Buffer.from('A');
        let failNextSettlementRead = false;
        let invalidate: (() => void) | null = null;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-dynamic-9']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => {
                        if (failNextSettlementRead) {
                            failNextSettlementRead = false;
                            throw new Error('transient producer read failure');
                        }
                        return new Uint8Array(current);
                    },
                    observe: (notify: () => void) => {
                        invalidate = notify;
                        return { dispose: () => { invalidate = null; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: { digest: string }[] = [];
        service.watch('live', (change) => { changes.push(change); });
        // Let establishment resynchronization settle before arming the failure
        // intended only for the producer invalidation below.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(changes).toEqual([]);

        current = Buffer.from('B');
        failNextSettlementRead = true;
        invalidate!();

        // No second producer notification follows. A green implementation has
        // to perform its owner-local bounded resettlement rather than rely on a
        // UI poller, reconnect, or another broker signal.
        await new Promise((resolve) => setTimeout(resolve, 450));

        expect(changes).toEqual([
            { digest: digest(Buffer.from('A')) },
            { digest: digest(Buffer.from('B')) },
        ]);
    });

    it('refuses a dynamic declaration with no registered producer', async () => {
        await expect(createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-dynamic-9']]),
            dynamicProducers: [],
        })).rejects.toMatchObject({ code: 'plugin_resource_producer_unavailable' });
    });
});

describe('dynamic resource watch retirement (EU-4b)', () => {
    it('stops delivering to a watcher whose plugin generation is no longer current', async () => {
        let current = Buffer.from('a');
        let invalidate: (() => void) | null = null;
        let disposedProducerSubscriptions = 0;
        let generationCurrent = true;
        const contribution: ResolvedResourceContribution = {
            provenance: 'external',
            source: { kind: 'archive' },
            pluginId: 'acme.alpha',
            pluginRootPath: '/tmp/does-not-matter',
            manifestPath: '/tmp/does-not-matter/.happier-plugin/plugin.json',
            daemonEntryPath: null,
            sourceSpec: {
                kind: 'archive', locator: 'acme.alpha.tgz', trustPolicy: 'prompt', installPolicy: 'copy',
            },
            definition: {
                kindVersion: 1, id: 'live', type: 'config', source: 'dynamic', contentType: 'application/json',
            },
        };
        const owner = await createStablePluginResourcesOwner({
            registry: registry([contribution]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-dynamic-11']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(current),
                    observe: (notify: () => void) => {
                        invalidate = notify;
                        return { dispose: () => { disposedProducerSubscriptions += 1; invalidate = null; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => generationCurrent,
        });
        const changes: { digest: string }[] = [];
        service.watch('live', (change) => { changes.push(change); });

        current = Buffer.from('b');
        invalidate!();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(changes).toHaveLength(1);

        generationCurrent = false;
        current = Buffer.from('c');
        invalidate!();
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(changes).toHaveLength(1);
        expect(disposedProducerSubscriptions).toBe(1);
    });
});
