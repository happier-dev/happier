import { Session } from 'node:inspector/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../cli-common/sourceRuntimeEntries.mjs';
import { evaluatePortableCommonJs } from '../../test-support/evaluatePortableCommonJs.js';
import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';

it('evaluates the compiled Triage Account runtime and preserves first-use ingress validation', async () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
    const projectRoot = resolve(repositoryRoot, 'packages/plugins/triage');
    const packages = await readWorkspacePackages(repositoryRoot);
    const compile = (entryPath: string, requestedExports: readonly string[]) => compileUniversalPluginUiCommonJs({
        projectRoot, artifactId: 'triage-account-runtime', entryPath, requestedExports,
        exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    const compiled = await compile('src/accountRuntime.ts', ['activate']);
    const code = new TextDecoder().decode(compiled.bytes);
    expect(Object.keys(compiled.metafile.inputs).some(path => /triage\/src\/manifest\.ts$/.test(path))).toBe(false);
    const timings: number[] = [];
    for (let index = 0; index < 3; index += 1) {
        const module = { exports: {} as Record<string, unknown> };
        const start = performance.now();
        evaluatePortableCommonJs(code, module);
        timings.push(performance.now() - start);
        expect(module.exports.activate).toBeTypeOf('function');
    }
    const session = new Session();
    session.connect();
    try {
        await session.post('Profiler.enable');
        await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        evaluatePortableCommonJs(code, { exports: {} });
        const { result } = await session.post('Profiler.takePreciseCoverage');
        const counts = Object.fromEntries(['cloneProtocolSchemaDocument', 'snapshotConstructedProtocolSchema',
            'normalizePluginJsonSchema', 'captureDefinePluginAuthorValue', 'readManifest'].map(name => [name,
            result.flatMap(script => script.functions).filter(fn => fn.functionName === name)
                .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0)]));
        console.info('triage-compiled-cold-evaluation', { timingsMs: timings, counts, bytes: compiled.bytes.length });
        expect(counts.readManifest).toBe(0);
    } finally {
        await session.post('Profiler.stopPreciseCoverage');
        session.disconnect();
    }
    const input = await compile('src/actions/listEntriesProtocol.ts', ['TriageListEntriesInputV1Schema']);
    const module = { exports: {} as Record<string, unknown> };
    evaluatePortableCommonJs(new TextDecoder().decode(input.bytes), module);
    const schema = module.exports.TriageListEntriesInputV1Schema as {
        parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean }; readonly jsonSchema: object;
    };
    const value = { v: 1, sources: { kind: 'allConfigured' }, limit: 1, order: 'newest' };
    expect(schema.parse(value)).toEqual(value);
    expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
    expect(schema.safeParse({ ...value, limit: 'invalid' }).success).toBe(false);
    expect(structuredClone(schema.jsonSchema)).toEqual(schema.jsonSchema);
    expect(schema.jsonSchema).toBe(schema.jsonSchema);
}, 60_000);
