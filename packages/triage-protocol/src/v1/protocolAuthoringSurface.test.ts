import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const v1Directory = new URL('./', import.meta.url);
const testingDirectory = new URL('../testing/', import.meta.url);

const ALLOWED_SDK_SUBPATHS = [
    '@happier-dev/plugin-sdk/protocol',
    '@happier-dev/plugin-sdk/contributions',
    '@happier-dev/plugin-sdk/connected-accounts',
    '@happier-dev/plugin-sdk/manifest',
    '@happier-dev/plugin-sdk/webhooks',
    '@happier-dev/plugin-sdk/sessions',
    '@happier-dev/plugin-sdk/automations',
] as const;

const RETIRED_AUTHORING_SPELLINGS = [
    'defineProtocolSchema',
    'adoptProtocolSchema',
    'PublicProtocolSchema',
    'ProtocolAuthoringSchema',
    'ProtocolJsonValueSchema',
    'defineProtocolUniqueArrayBy',
    '.refine',
    '.superRefine',
] as const;

async function productionSources(directory: URL): Promise<readonly string[]> {
    const entries = await readdir(directory, { recursive: true });
    return Promise.all(entries
        .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
        .map((entry) => readFile(new URL(entry, directory), 'utf8')));
}

describe('Triage protocol authoring surface', () => {
    it('composes V1 only from validator-neutral public authoring values', async () => {
        const v1Sources = await productionSources(v1Directory);
        const sources = [
            ...v1Sources,
            ...await productionSources(testingDirectory),
        ];

        expect(sources).not.toHaveLength(0);
        for (const source of sources) {
            expect(source).not.toMatch(/from\s+['"]@happier-dev\/protocol(?:\/[^'"]*)?['"]/u);
            expect(source).not.toMatch(/from\s+['"]zod['"]/u);
            expect(source).not.toContain('_zod');
            expect(source).not.toContain('ZodSchema');
            for (const retired of RETIRED_AUTHORING_SPELLINGS) {
                expect(source).not.toContain(retired);
            }
        }

        // `/testing/v1` derives maximum encoded sizes from published JSON Schema and
        // can therefore inspect a pattern with the standard library. The executable
        // V1 schemas themselves must stay entirely within the public composition
        // algebra; letting a test utility widen that boundary would be a false pass.
        for (const source of v1Sources) {
            expect(source).not.toMatch(/\bRegExp\b/u);
        }
    });

    it('imports only allowlisted browser-safe public SDK entry points', async () => {
        const sources = [
            ...await productionSources(v1Directory),
            ...await productionSources(testingDirectory),
        ];
        const sdkSpecifiers = new Set<string>();
        for (const source of sources) {
            for (const match of source.matchAll(/from\s+['"](@happier-dev\/plugin-sdk[^'"]*)['"]/gu)) {
                sdkSpecifiers.add(match[1]!);
            }
        }

        expect(sdkSpecifiers.size).toBeGreaterThan(0);
        for (const specifier of sdkSpecifiers) {
            expect(ALLOWED_SDK_SUBPATHS).toContain(specifier);
        }
    });

    it('declares no runtime dependency and no validator dependency', async () => {
        const packageJson = JSON.parse(await readFile(
            new URL('../../package.json', import.meta.url),
            'utf8',
        )) as Readonly<{
            dependencies?: Readonly<Record<string, string>>;
            devDependencies?: Readonly<Record<string, string>>;
            optionalDependencies?: Readonly<Record<string, string>>;
            peerDependencies?: Readonly<Record<string, string>>;
        }>;

        for (const group of [
            packageJson.dependencies,
            packageJson.devDependencies,
            packageJson.optionalDependencies,
            packageJson.peerDependencies,
        ]) {
            expect(group?.['@happier-dev/protocol']).toBeUndefined();
            expect(group?.zod).toBeUndefined();
        }
        expect(Object.keys(packageJson.dependencies ?? {})).toEqual([]);
    });
});
