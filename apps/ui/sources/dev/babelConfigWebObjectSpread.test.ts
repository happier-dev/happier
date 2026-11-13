import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const APP_ROOT = resolve(import.meta.dirname, '../..');
const AUTHORING = resolve(APP_ROOT, '../../packages/plugin-sdk/src/targetedContributionAuthoring.ts');

type Authoring = typeof import('@happier-dev/plugin-sdk/contributions');

/** Compiles source with this app's own Babel config as Metro does for the web build. */
function compileForAppWebBuild(source: string, filename: string): string {
    const babel = require('@babel/core') as typeof import('@babel/core');
    const transformed = babel.transformSync(source, {
        filename,
        root: APP_ROOT,
        cwd: APP_ROOT,
        babelrc: false,
        configFile: resolve(APP_ROOT, 'babel.config.js'),
        caller: { name: 'metro', platform: 'web', isDev: false, supportsStaticESM: true } as never,
    });
    if (!transformed?.code) throw new Error('Babel produced no code');
    return transformed.code;
}

async function importCompiled<T>(code: string, name: string): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'app-web-build-'));
    const file = join(directory, `${name}.mjs`);
    await writeFile(file, code);
    try {
        return await import(/* @vite-ignore */ pathToFileURL(file).href);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/**
 * The shipped pattern: an object literal that spreads a base object and adds
 * a getter which either defers work or reads live state.
 */
const SPREAD_WITH_GETTERS = `
export function withDeferredProjection<T extends object>(base: T, project: () => unknown) {
    return { ...base, get projection() { return project(); } };
}
export function withLiveSocketId<T extends { socketId: string | null }>(socket: T) {
    return { ...socket, get socketId() { return socket.socketId; } };
}
`;

type SpreadWithGetters = {
    withDeferredProjection: <T extends object>(base: T, project: () => unknown) => T & { readonly projection: unknown };
    withLiveSocketId: <T extends { socketId: string | null }>(socket: T) => T;
};

describe('app web build object spread', () => {
    it('keeps a getter after a spread deferred until it is read', async () => {
        const code = compileForAppWebBuild(SPREAD_WITH_GETTERS, resolve(APP_ROOT, 'sources/dev/spreadWithGetters.ts'));
        const { withDeferredProjection } = await importCompiled<SpreadWithGetters>(code, 'spreadWithGetters');
        let projections = 0;

        const bound = withDeferredProjection({ id: 'base' }, () => { projections += 1; return 'projected'; });
        const projectedAtCreation = projections;

        expect({ projectedAtCreation }).toEqual({ projectedAtCreation: 0 });
        expect(bound.id).toBe('base');
        expect(bound.projection).toBe('projected');
        expect(projections).toBe(1);
    });

    it('keeps a getter after a spread reading live state', async () => {
        const code = compileForAppWebBuild(SPREAD_WITH_GETTERS, resolve(APP_ROOT, 'sources/dev/spreadWithGetters.ts'));
        const { withLiveSocketId } = await importCompiled<SpreadWithGetters>(code, 'spreadWithGetters');
        const socket = { socketId: null as string | null };

        const bound = withLiveSocketId(socket);
        socket.socketId = 'connected-socket';

        expect(bound.socketId).toBe('connected-socket');
    });
});

/** Compiles the real SDK authoring module and rewrites its relative imports to source files. */
async function importAuthoringAsAppWebBuild(): Promise<Pick<Authoring, 'defineContributionPoint' | 'defineContributionProtocol'>> {
    const code = compileForAppWebBuild(await readFile(AUTHORING, 'utf8'), AUTHORING)
        .replace(/(from\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (_match, prefix: string, _quote: string, specifier: string) => (
            `${prefix}${JSON.stringify(pathToFileURL(resolve(dirname(AUTHORING), specifier.replace(/\.js$/, '.ts'))).href)}`
        ));
    return await importCompiled(code, 'targetedContributionAuthoring');
}

describe('plugin SDK contribution points in the app web build', () => {
    it('project no protocol document until a reader asks for it', async () => {
        const authoring = await importAuthoringAsAppWebBuild();
        const real = defineProtocolObject({ providerId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        let descriptorDocumentReads = 0;
        const descriptor = Object.freeze({
            get jsonSchema() { descriptorDocumentReads += 1; return real.jsonSchema; },
            parse: real.parse,
            safeParse: real.safeParse,
            optional: real.optional,
            nullable: real.nullable,
        });
        const protocol = authoring.defineContributionProtocol({ id: 'deferred-point-protocol', version: 1, descriptor, operations: {} });
        const readsBeforePoint = descriptorDocumentReads;

        const point = authoring.defineContributionPoint([protocol]);
        const projectedAtDefinition = descriptorDocumentReads - readsBeforePoint;
        const projected = point.protocols;

        expect({ projectedAtDefinition }).toEqual({ projectedAtDefinition: 0 });
        expect(descriptorDocumentReads).toBeGreaterThan(readsBeforePoint);
        expect(projected).toMatchObject([{ id: 'deferred-point-protocol', version: 1, descriptor: { type: 'object' } }]);
        expect(point.protocols).toBe(projected);
    });
});
