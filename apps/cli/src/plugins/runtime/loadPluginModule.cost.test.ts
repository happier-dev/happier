import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ transforms: [] as string[], cache: undefined as string | undefined }));
// Count work at the real third-party compiler boundary; keep evaluation real.
vi.mock('jiti', async (importOriginal) => {
    const actual = await importOriginal<typeof import('jiti')>();
    return {
        ...actual,
        createJiti: ((id, options = {}) => {
            const measuredOptions = { ...options, ...(observed.cache ? { fsCache: observed.cache } : {}) };
            const transform = actual.createJiti(id, measuredOptions).options.transform!;
            return actual.createJiti(id, {
                ...measuredOptions,
                transform(input) {
                    observed.transforms.push(input.filename ?? '<unknown>');
                    return transform(input);
                },
            });
        }) satisfies typeof actual.createJiti,
    };
});

import { createPluginTypeScriptCandidateScope, loadVerifiedPluginModule } from './loadPluginModule';

it('does not transform unchanged candidate bytes again and still observes same-size source edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-evaluator-cost-'));
    const entry = join(root, 'index.ts');
    try {
        await mkdir(join(root, 'children'));
        await writeFile(entry, 'export { value } from "./children/value.ts";');
        const child = join(root, 'children/value.ts');
        await writeFile(child, 'export const value: number = 1;');
        const load = async () => loadVerifiedPluginModule({
            entryPath: entry,
            loadMode: 'source-ts',
            generationScope: await createPluginTypeScriptCandidateScope({ rootPath: root }),
        });
        expect(await load()).toMatchObject({ value: 1 });
        expect(observed.transforms).toContain(child);
        observed.transforms = [];
        expect(await load()).toMatchObject({ value: 1 });
        expect(observed.transforms).toEqual([]);
        await writeFile(child, 'export const value: number = 2;');
        observed.transforms = [];
        expect(await load()).toMatchObject({ value: 2 });
        expect(observed.transforms).toEqual([child]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

it.each(['published', 'source'] as const)('keeps %s Protocol dependency compilation at its owning boundary', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-protocol-cost-'));
    const entryPath = join(root, 'index.ts');
    const specifier = '@happier-dev/protocol/plugins/contribution-identity';
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@happier-dev/plugin-sdk'));
    const publishedEntry = sdkRequire.resolve(specifier);
    const sourceEntry = fileURLToPath(new URL('../../../../../packages/protocol/src/plugins/contributionIdentity.ts', import.meta.url));
    observed.cache = join(root, 'transform-cache');
    observed.transforms = [];
    try {
        await writeFile(entryPath, [
            `import { buildQualifiedPluginContributionKey } from ${JSON.stringify(kind === 'published' ? pathToFileURL(publishedEntry).href : specifier)};`,
            'export const key = buildQualifiedPluginContributionKey({ pluginId: "examples.model-pack", localId: "english-small" });',
        ].join('\n'));
        const loaded = await loadVerifiedPluginModule({
            entryPath,
            loadMode: 'source-ts',
            generationScope: await createPluginTypeScriptCandidateScope({
                rootPath: root,
                ...(kind === 'source' ? { aliases: { [specifier]: sourceEntry } } : {}),
            }),
        });
        expect(loaded.key).toBe('examples.model-pack/english-small');
        if (kind === 'published') {
            // Published Protocol JavaScript belongs to Node, not the author compiler.
            expect(observed.transforms.filter(path => path.replaceAll('\\', '/').includes('/node_modules/@happier-dev/protocol/'))).toEqual([]);
        } else {
            // Current workspace source must still go through the author evaluator.
            expect(observed.transforms.map(path => normalize(path))).toContain(normalize(sourceEntry));
        }
    } finally {
        observed.cache = undefined;
        await rm(root, { recursive: true, force: true });
    }
});

it.each(['import', 'require'] as const)('does not compile published Zod %s and still evaluates changed author source', async (condition) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-zod-cost-'));
    const entryPath = join(root, 'index.ts');
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@happier-dev/plugin-sdk'));
    const publishedEntry = sdkRequire.resolve('zod');
    // Zod publishes separate ESM/CJS graphs; the SDK's ESM import uses index.js.
    const dependency = condition === 'import'
        ? new URL('./index.js', pathToFileURL(publishedEntry)).href
        : pathToFileURL(publishedEntry).href;
    observed.cache = join(root, 'transform-cache');
    try {
        for (const revision of [1, 2]) {
            await writeFile(entryPath, [
                `import { z } from ${JSON.stringify(dependency)};`,
                `export const parsed = z.object({ revision: z.number() }).parse({ revision: ${revision} });`,
                'export const invalidAccepted = z.number().safeParse("invalid").success;',
            ].join('\n'));
            observed.transforms = [];
            const loaded = await loadVerifiedPluginModule({
                entryPath,
                loadMode: 'source-ts',
                generationScope: await createPluginTypeScriptCandidateScope({ rootPath: root }),
            });
            expect(loaded.parsed).toEqual({ revision });
            expect(loaded.invalidAccepted).toBe(false);
            expect(observed.transforms).toContain(entryPath);
            expect(observed.transforms.filter(path => path.replaceAll('\\', '/').includes('/node_modules/zod/'))).toEqual([]);
        }
    } finally {
        observed.cache = undefined;
        await rm(root, { recursive: true, force: true });
    }
});
