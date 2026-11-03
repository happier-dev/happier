import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));
const { applyPatch, parsePatch, reversePatch } = require('diff');
const filename = require.resolve('@expo/metro-config/build/serializer/serializeChunks');
const patchFile = path.resolve(uiRoot, '../../patches/@expo__metro-config@55.0.13.patch');
// An explicit test fixture can exercise a held candidate without installing it
// or representing it as the tracked dependency patch.
const suppliedPatch = process.env.HAPPIER_TEST_METRO_CONFIG_PATCH;
const serializerPatch = parsePatch(suppliedPatch ?? readFileSync(patchFile, 'utf8')).find(
    patch => patch.newFileName === 'b/build/serializer/serializeChunks.js',
);
const installed = readFileSync(filename, 'utf8');
// Exercise proposed patch bytes without changing node_modules or requiring an install.
const upstream = serializerPatch ? applyPatch(installed, reversePatch(serializerPatch)) || installed : installed;
const candidate = serializerPatch ? applyPatch(upstream, serializerPatch) : upstream;
assert.equal(typeof candidate, 'string', 'the pinned serializer patch must apply without fuzz');

function loadSerializer(source) {
    const loaded = new Module(filename);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    // Test-only visibility; all chunk construction and serialization stay real.
    loaded._compile(source + '\nexports.inspectChunks = (entry, pre, graph, options, chunks = new Set()) => gatherChunks(pre, chunks, { path: entry, test: pathToRegex(entry) }, pre, graph, options, false, true);\n', filename);
    return loaded.exports;
}

// Compare discovery algorithms under one chunk policy. Reversing the complete
// dependency patch also removes intentional lazy-common/load-plan changes, so
// transplant only pinned upstream discovery into the candidate policy.
const discoveryFunctions = /function getEntryModulesForChunkSettings\([\s\S]*?(?=function removeEntryDepsFromAsyncChunks\()/;
const upstreamDiscovery = upstream.match(discoveryFunctions);
assert.ok(upstreamDiscovery, 'the pinned upstream discovery functions must be present');
assert.match(candidate, discoveryFunctions, 'the candidate discovery functions must be present');
const baseline = candidate.replace(discoveryFunctions, () => upstreamDiscovery[0]).replace(
    'gatherChunks(preModules, chunks, { path: entryFile }',
    'gatherChunks(preModules, chunks, { test: pathToRegex(entryFile) }',
);
const baselineSerializer = loadSerializer(baseline);
const patchedSerializer = loadSerializer(candidate);

function makeModule(name, dependencies = [], script = false) {
    const modulePath = `/serializer-fixture/${name}.js`;
    const source = script ? 'globalThis.serializerRuntime = true;' : '__d(function(global, require, importDefault, importAll, module, exports, dependencies) { exports.value = 1; });';
    return {
        path: modulePath,
        dependencies: new Map(dependencies.map(([name, asyncType = null], index) => [String(index), {
            absolutePath: name === null ? null : `/serializer-fixture/${name}.js`,
            data: { name: name ?? 'optional', data: { asyncType, isOptional: name === null } },
        }])),
        output: [{ type: script ? 'js/script' : 'js/module', data: { code: source, lineCount: 1, map: [] } }],
        getSource: () => Buffer.from(source),
    };
}

function makeGraph(modules, dependencies = new Map(modules.map(module => [module.path, module]))) {
    return { dependencies, transformOptions: { platform: 'web', dev: false, customTransformOptions: { baseUrl: '/app' } } };
}

function makeOptions(splitChunks = true) {
    const ids = new Map();
    return {
        projectRoot: '/serializer-fixture', serverRoot: '/serializer-fixture',
        dev: false, runModule: true, modulesOnly: false, includeAsyncPaths: false,
        processModuleFilter: () => true, shouldAddToIgnoreList: () => false,
        createModuleId: modulePath => {
            if (!ids.has(modulePath)) ids.set(modulePath, ids.size);
            return ids.get(modulePath);
        },
        getRunModuleStatement: id => `__r(${JSON.stringify(id)});`,
        serializerOptions: { splitChunks, exporting: true, includeSourceMaps: true },
        sourceMapUrl: 'https://example.invalid/index.js.map',
    };
}

function describeChunks(chunks) {
    return [...chunks].map(chunk => ({
        name: chunk.name, entries: chunk.entries.map(module => module.path),
        deps: [...chunk.deps].map(module => module.path), preModules: [...chunk.preModules].map(module => module.path),
        isAsync: chunk.isAsync, isEntry: chunk.isEntry, isVendor: chunk.isVendor,
    }));
}

test('chunk entry discovery visits the indexed graph linearly at export scale', () => {
    let visits = 0;
    class CountedDependencies extends Map {
        *entries() {
            for (const entry of super.entries()) { visits += 1; yield entry; }
        }
        get(key) { visits += 1; return super.get(key); }
    }
    class CountedChunks extends Set {
        *values() {
            for (const chunk of super.values()) { visits += chunk.entries.length; yield chunk; }
        }
    }
    const asyncCount = 1405;
    const modules = [makeModule('index', Array.from({ length: asyncCount }, (_, i) => [`route-${i}`, 'async']))];
    for (let i = 0; i < asyncCount; i += 1) modules.push(makeModule(`route-${i}`, [['shared-async', 'async']]));
    modules.push(makeModule('shared-async'));
    while (modules.length < 20520) modules.push(makeModule(`unrelated-${modules.length}`));
    const graph = makeGraph(modules, new CountedDependencies(modules.map(module => [module.path, module])));
    const chunks = patchedSerializer.inspectChunks(modules[0].path, [], graph, makeOptions(), new CountedChunks());
    assert.equal(chunks.size, asyncCount + 2);
    assert.ok(visits <= modules.length, `entry discovery visited ${visits} graph records for ${modules.length} modules`);
});

test('chunk entries, membership, workers, cycles, URLs, bundle bytes and maps match upstream discovery under the same chunk policy', async () => {
    const modules = [
        makeModule('index', [['entry-shared'], ['a', 'async'], ['b', 'async'], ['worker', 'worker'], [null]]),
        makeModule('entry-shared'),
        makeModule('a', [['common'], ['entry-shared'], ['b', 'async']]),
        makeModule('b', [['common'], ['a', 'async']]),
        makeModule('common', [['cycle']]), makeModule('cycle', [['common']]),
        makeModule('worker', [['common'], ['a', 'async']]),
    ];
    const graph = makeGraph(modules);
    const pre = [makeModule('runtime', [], true)];
    for (const splitChunks of [true, false]) {
        assert.deepEqual(
            describeChunks(patchedSerializer.inspectChunks(modules[0].path, pre, graph, makeOptions(splitChunks))),
            describeChunks(baselineSerializer.inspectChunks(modules[0].path, pre, graph, makeOptions(splitChunks))),
        );
        const serialize = serializer => serializer.graphToSerialAssetsAsync({}, { includeSourceMaps: true, splitChunks },
            modules[0].path, pre, graph, makeOptions(splitChunks));
        const expected = await serialize(baselineSerializer);
        const actual = await serialize(patchedSerializer);
        assert.ok(actual.artifacts.some(artifact => artifact.type === 'js'));
        assert.ok(actual.artifacts.some(artifact => artifact.type === 'map'));
        assert.deepEqual(actual, expected);
    }
});

test('wildcard paths retain upstream matching and per-export visited state is fresh', () => {
    const modules = [makeModule('route-a', [['route-b', 'async']]), makeModule('route-b'), makeModule('other')];
    const graph = makeGraph(modules);
    for (const entry of ['/serializer-fixture/route*.js', '/serializer-fixture/missing.js', modules[0].path, modules[0].path]) {
        assert.deepEqual(
            describeChunks(patchedSerializer.inspectChunks(entry, [], graph, makeOptions())),
            describeChunks(baselineSerializer.inspectChunks(entry, [], graph, makeOptions())),
        );
    }
});
