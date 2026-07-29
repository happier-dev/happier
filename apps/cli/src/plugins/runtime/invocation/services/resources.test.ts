import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
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
        manifestDigest: digest(Buffer.from('manifest')),
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'archive', locator: `${pluginId}.tgz`, trustPolicy: 'prompt', installPolicy: 'copy',
            resolvedDigest: digest(Buffer.from('package')),
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
        digest: digest(bytes),
    };
    return { rootPath, relativePath, contribution, file, bytes };
}

function registry(generationId: string, resources: readonly ResolvedResourceContribution[]): Pick<ResolvedContributionRegistry, 'generationId' | 'resources'> {
    return { generationId, resources };
}

describe('stable plugin resources owner', () => {
    it('serves exact local ids from the current immutable generation with plugin isolation', async () => {
        const alpha = await fixture('acme.alpha');
        const beta = await fixture('acme.beta', 'shared', Buffer.from('beta'));
        const owner = await createStablePluginResourcesOwner({
            registry: registry('registry:7', [alpha.contribution, beta.contribution]),
            generations: new Map([
                ['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: alpha.rootPath, files: [alpha.file] }],
                ['acme.beta', { pluginId: 'acme.beta', immutableGenerationId: 'beta-7', rootPath: beta.rootPath, files: [beta.file] }],
            ]),
        });

        const alphaService = owner.bind({
            pluginId: 'acme.alpha', generation: 'registry:7', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const betaService = owner.bind({
            pluginId: 'acme.beta', generation: 'registry:7', signal: new AbortController().signal,
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

    it('accepts the measured official SDK closure admitted by the immutable generation owner', async () => {
        const value = await fixture('acme.sdk-closure');
        const files: ImmutablePluginGenerationRecord['files'] = [
            value.file,
            ...Array.from({ length: 6_355 }, (_, index) => ({
                relativePath: `node_modules/sdk/file-${String(index).padStart(4, '0')}.js`,
                byteLength: 0,
                digest: digest(Buffer.from(`sdk-${index}`)),
            })),
        ];

        const owner = await createStablePluginResourcesOwner({
            registry: registry('registry:sdk-closure', [value.contribution]),
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
            registry: registry('registry:7', [exact.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: exact.rootPath, files: [exact.file] }]]),
        });
        const service = owner.bind({ pluginId: 'acme.alpha', generation: 'registry:7', signal: new AbortController().signal, isGenerationCurrent: () => true });

        expect(Buffer.from((await service.read('shared', { maxBytes: exact.bytes.byteLength })).bytes)).toEqual(exact.bytes);
        await expect(service.read('shared', { maxBytes: exact.bytes.byteLength - 1 })).rejects.toMatchObject({ code: 'plugin_resource_too_large' });
        await expect(service.read('shared', { maxBytes: -1 })).rejects.toMatchObject({ code: 'plugin_resource_limit_invalid' });

        const empty = await fixture('acme.empty', 'empty', Buffer.alloc(0));
        const emptyOwner = await createStablePluginResourcesOwner({
            registry: registry('registry:empty', [empty.contribution]),
            generations: new Map([['acme.empty', {
                pluginId: 'acme.empty', immutableGenerationId: 'empty-1', rootPath: empty.rootPath, files: [empty.file],
            }]]),
        });
        const emptyService = emptyOwner.bind({
            pluginId: 'acme.empty', generation: 'registry:empty', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        await expect(emptyService.read('empty', { maxBytes: 0 })).resolves.toMatchObject({ bytes: new Uint8Array() });

        const oversized = await fixture('acme.oversized', 'large', Buffer.alloc(1));
        await expect(createStablePluginResourcesOwner({
            registry: registry('registry:8', [oversized.contribution]),
            generations: new Map([['acme.oversized', {
                pluginId: 'acme.oversized', immutableGenerationId: 'oversized-8', rootPath: oversized.rootPath,
                files: [{ ...oversized.file, byteLength: MAX_PLUGIN_RESOURCE_BYTES + 1 }],
            }]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_capacity_exceeded' });

        const aggregateContributions: ResolvedResourceContribution[] = [];
        const aggregateGenerations = new Map<string, { pluginId: string; immutableGenerationId: string; rootPath: string; files: ImmutablePluginGenerationRecord['files'] }>();
        for (let index = 0; index <= MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES / MAX_PLUGIN_RESOURCE_BYTES; index += 1) {
            const item = await fixture(`acme.aggregate-${index}`, `item-${index}`, Buffer.from('x'));
            aggregateContributions.push(item.contribution);
            aggregateGenerations.set(`acme.aggregate-${index}`, {
                pluginId: `acme.aggregate-${index}`, immutableGenerationId: `aggregate-${index}`, rootPath: item.rootPath,
                files: [{ ...item.file, byteLength: MAX_PLUGIN_RESOURCE_BYTES }],
            });
        }
        await expect(createStablePluginResourcesOwner({
            registry: registry('registry:aggregate', aggregateContributions),
            generations: aggregateGenerations,
        })).rejects.toMatchObject({ code: 'plugin_resource_capacity_exceeded' });
    });

    it('rechecks containment, declared file identity, size, and digest on every read', async () => {
        const value = await fixture('acme.alpha');
        const owner = await createStablePluginResourcesOwner({
            registry: registry('registry:7', [value.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        });
        const service = owner.bind({ pluginId: 'acme.alpha', generation: 'registry:7', signal: new AbortController().signal, isGenerationCurrent: () => true });

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
                registry: registry(`registry:${name}`, [contribution]),
                generations: new Map([[`acme.${name}`, { pluginId: `acme.${name}`, immutableGenerationId: `${name}-1`, rootPath: value.rootPath, files: [value.file] }]]),
            })).rejects.toMatchObject({ code: expectedCode });
        }

        const linked = await fixture('acme.linked');
        await rm(join(linked.rootPath, linked.relativePath));
        await symlink(outsidePath, join(linked.rootPath, linked.relativePath));
        await expect(createStablePluginResourcesOwner({
            registry: registry('registry:linked', [linked.contribution]),
            generations: new Map([['acme.linked', { pluginId: 'acme.linked', immutableGenerationId: 'linked-1', rootPath: linked.rootPath, files: [linked.file] }]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_path_denied' });
    });

    it('fences aborts and retired generations before and after asynchronous admission', async () => {
        const value = await fixture('acme.alpha');
        const owner = await createStablePluginResourcesOwner({
            registry: registry('registry:7', [value.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        });
        let current = true;
        const parent = new AbortController();
        const service = owner.bind({ pluginId: 'acme.alpha', generation: 'registry:7', signal: parent.signal, isGenerationCurrent: () => current });
        const call = new AbortController();
        call.abort();
        await expect(service.read('shared', { signal: call.signal })).rejects.toMatchObject({ code: 'plugin_resource_aborted' });
        current = false;
        expect(() => service.describe('shared')).toThrowError(expect.objectContaining({ code: 'plugin_generation_stale' }));
        await expect(service.read('shared')).rejects.toMatchObject({ code: 'plugin_generation_stale' });

        current = true;
        expect(() => owner.retireGeneration('registry:wrong')).toThrowError(expect.objectContaining({
            code: 'plugin_resource_generation_invalid',
        }));
        await expect(service.read('shared')).resolves.toMatchObject({ digest: digest(value.bytes) });
        owner.retireGeneration('registry:7');
        expect(() => service.describe('shared')).toThrowError(expect.objectContaining({ code: 'plugin_generation_stale' }));
    });

    it('rechecks durable committed-generation currentness before serving bytes', async () => {
        const value = await fixture('acme.alpha');
        let committedGenerationCurrent = true;
        const owner = await createStablePluginResourcesOwner({
            registry: registry('registry:7', [value.contribution]),
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file],
            }]]),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', generation: 'registry:7', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        await expect(service.read('shared')).resolves.toMatchObject({ digest: digest(value.bytes) });
        committedGenerationCurrent = false;
        await expect(service.read('shared')).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    });

    it('rejects a generation record keyed under a different plugin identity', async () => {
        const value = await fixture('acme.alpha');

        await expect(createStablePluginResourcesOwner({
            registry: registry('registry:7', [value.contribution]),
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
            registry: registry('registry:7', [value.contribution]),
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.alpha',
                immutableGenerationId: 'alpha-7',
                rootPath: value.rootPath,
                files: [value.file],
            }]]),
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', generation: 'registry:7',
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
            registry: registry('registry:7', [value.contribution]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        });
        const service = owner.bind({ pluginId: 'acme.alpha', generation: 'registry:7', signal: new AbortController().signal, isGenerationCurrent: () => true });
        expect(() => service.watch('shared', () => {})).toThrowError(expect.objectContaining({ code: 'plugin_resource_watch_unavailable' }));

        const hostile = Object.create(null) as ResolvedResourceContribution;
        Object.defineProperty(hostile, 'pluginId', { enumerable: true, get: () => { throw new Error('SECRET GETTER TEXT'); } });
        await expect(createStablePluginResourcesOwner({
            registry: registry('registry:hostile', [hostile]),
            generations: new Map(),
        })).rejects.toMatchObject({ code: 'plugin_resource_declaration_invalid', message: expect.not.stringContaining('SECRET') });

        const inherited = Object.assign(Object.create({ inherited: true }), value.contribution) as ResolvedResourceContribution;
        await expect(createStablePluginResourcesOwner({
            registry: registry('registry:prototype', [inherited]),
            generations: new Map([['acme.alpha', { pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: value.rootPath, files: [value.file] }]]),
        })).rejects.toMatchObject({ code: 'plugin_resource_declaration_invalid' });
    });
});
