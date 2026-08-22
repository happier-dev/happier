import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import type { ImmutablePluginGenerationRecord } from '@/plugins/store/registry/generationStore';

import { createStablePluginResourcesOwner } from './resources';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function createPng(width: number, height: number): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 27, g: 71, b: 140, alpha: 1 },
        },
    }).png().toBuffer();
}

async function brandFixture(params: Readonly<{
    pluginId: string;
    bytes: Uint8Array;
    write?: boolean;
}>): Promise<Readonly<{
    contribution: ResolvedResourceContribution;
    generation: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
        rootPath: string;
        files: ImmutablePluginGenerationRecord['files'];
        brandIconResourceId: string;
    }>;
}>> {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-plugin-brand-'));
    roots.push(rootPath);
    await mkdir(join(rootPath, 'assets'));
    const relativePath = 'assets/brand.png';
    if (params.write !== false) {
        await writeFile(join(rootPath, relativePath), params.bytes);
    }
    return Object.freeze({
        contribution: {
            provenance: 'external',
            source: { kind: 'archive' },
            pluginId: params.pluginId,
            pluginRootPath: rootPath,
            manifestPath: join(rootPath, '.happier-plugin/plugin.json'),
            daemonEntryPath: null,
            sourceSpec: {
                kind: 'archive',
                locator: `${params.pluginId}.tgz`,
                trustPolicy: 'prompt',
                installPolicy: 'copy',
            },
            definition: {
                kindVersion: 1,
                id: 'brand-icon',
                type: 'asset',
                path: relativePath,
                contentType: 'image/png',
                digest: digest(params.bytes),
            },
        },
        generation: Object.freeze({
            pluginId: params.pluginId,
            immutableGenerationId: `${params.pluginId}-g1`,
            rootPath,
            files: [{ relativePath, byteLength: params.bytes.byteLength }],
            brandIconResourceId: 'brand-icon',
        }),
    });
}

describe('portable plugin brand Resource admission', () => {
    it('projects one verified square packaged PNG without exposing its bytes or path', async () => {
        const bytes = await createPng(64, 64);
        const fixture = await brandFixture({ pluginId: 'acme.brand', bytes });
        const owner = await createStablePluginResourcesOwner({
            registry: { resources: [fixture.contribution] } as Pick<ResolvedContributionRegistry, 'resources'>,
            generations: new Map([['acme.brand', fixture.generation]]),
        });

        expect(owner.getPluginBrandAsset('acme.brand')).toEqual({
            state: 'available',
            resource: { pluginId: 'acme.brand', localId: 'brand-icon' },
            width: 64,
            height: 64,
            digest: digest(bytes),
        });
        expect(owner.getPluginBrandAsset('acme.brand')).not.toHaveProperty('bytes');
        expect(owner.getPluginBrandAsset('acme.brand')).not.toHaveProperty('path');

        owner.retirePlugin('acme.brand');
        expect(owner.getPluginBrandAsset('acme.brand')).toEqual({ state: 'retired' });
    });

    it('turns missing, malformed, rectangular, and over-budget declared brand files into fallbacks without rejecting the plugin', async () => {
        const valid = await createPng(64, 64);
        const malformed = await brandFixture({
            pluginId: 'acme.malformed',
            bytes: Buffer.from('not actually a PNG'),
        });
        const missing = await brandFixture({
            pluginId: 'acme.missing',
            bytes: valid,
            write: false,
        });
        const rectangularBytes = await createPng(64, 65);
        const rectangular = await brandFixture({
            pluginId: 'acme.rectangular',
            bytes: rectangularBytes,
        });
        const tooSmall = await brandFixture({
            pluginId: 'acme.too-small',
            bytes: await createPng(63, 63),
        });
        const tooLarge = await brandFixture({
            pluginId: 'acme.too-large',
            bytes: await createPng(513, 513),
        });
        const oversized = await brandFixture({
            pluginId: 'acme.oversized',
            bytes: Buffer.concat([valid, Buffer.alloc(256 * 1024)]),
        });
        const owner = await createStablePluginResourcesOwner({
            registry: {
                resources: [
                    malformed.contribution,
                    missing.contribution,
                    rectangular.contribution,
                    tooSmall.contribution,
                    tooLarge.contribution,
                    oversized.contribution,
                ],
            } as Pick<ResolvedContributionRegistry, 'resources'>,
            generations: new Map([
                ['acme.malformed', malformed.generation],
                ['acme.missing', missing.generation],
                ['acme.rectangular', rectangular.generation],
                ['acme.too-small', tooSmall.generation],
                ['acme.too-large', tooLarge.generation],
                ['acme.oversized', oversized.generation],
            ]),
        });

        expect(owner.getPluginBrandAsset('acme.malformed')).toEqual({ state: 'invalid' });
        expect(owner.getPluginBrandAsset('acme.missing')).toEqual({ state: 'missing' });
        expect(owner.getPluginBrandAsset('acme.rectangular')).toEqual({ state: 'invalid' });
        expect(owner.getPluginBrandAsset('acme.too-small')).toEqual({ state: 'invalid' });
        expect(owner.getPluginBrandAsset('acme.too-large')).toEqual({ state: 'invalid' });
        expect(owner.getPluginBrandAsset('acme.oversized')).toEqual({ state: 'invalid' });
        expect(owner.hasPlugin('acme.malformed')).toBe(true);
        expect(owner.hasPlugin('acme.missing')).toBe(true);
        expect(Buffer.from((await owner.bind({
            pluginId: 'acme.rectangular',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }).read('brand-icon')).bytes)).toEqual(rectangularBytes);
    });
});
