// @happier-test-preparation source
// Probes authored graphs with installed tooling; no workspace dist/publication inputs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const require = createRequire(import.meta.url);
const metro = require('metro-resolver');
const metroConfig = require('../../metro.config.js');

// Use Metro's real extension/platform ordering and the app's authored config.
// These filesystem adapters replace Metro's indexed filesystem, not its resolver.
const packages = new Map();
function getPackageForModule(file) {
    const directory = dirname(file);
    if (!packages.has(directory)) {
        const packagePath = join(directory, 'package.json');
        try {
            packages.set(directory, { rootPath: directory, packageJson: JSON.parse(readFileSync(packagePath, 'utf8')) });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const parent = dirname(directory);
            packages.set(directory, parent === directory ? null : getPackageForModule(join(parent, '_')));
        }
    }
    const info = packages.get(directory);
    return info && { ...info, packageRelativePath: relative(info.rootPath, file) };
}

function resolveUiSource(originModulePath, modulePath, platform) {
    const path = modulePath.startsWith('@/')
        ? join(repoRoot, 'apps/ui/sources', modulePath.slice(2)) : modulePath;
    try {
        return metro.resolve({
            originModulePath,
            sourceExts: metroConfig.resolver.sourceExts,
            assetExts: new Set(metroConfig.resolver.assetExts),
            mainFields: metroConfig.resolver.resolverMainFields,
            preferNativePlatform: platform !== 'web',
            getPackageForModule,
            getPackage: file => JSON.parse(readFileSync(file, 'utf8')),
            doesFileExist: existsSync,
            fileSystemLookup(file) {
                try {
                    const stat = statSync(file);
                    return { exists: true, type: stat.isDirectory() ? 'd' : 'f', realPath: realpathSync(file) };
                } catch (error) {
                    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
                    return { exists: false };
                }
            },
            resolveAsset: () => null,
        }, path, platform);
    } catch (error) {
        if (error instanceof metro.FailedToResolvePathError) return null;
        throw error;
    }
}

test('hosted HTML keeps the guest bootstrap outside its static entry graph', async () => {
    const entry = 'apps/ui/sources/components/plugins/hostedWeb/buildHostedHtmlDocument.ts';
    const { metafile } = await build({
        absWorkingDir: repoRoot, entryPoints: [entry], bundle: true, splitting: true,
        format: 'esm', platform: 'browser', conditions: ['happier-source'],
        outdir: '.hosted-html-dependency-probe', write: false, metafile: true, logLevel: 'silent',
    });
    const outputs = metafile.outputs;
    const required = new Set();
    const visit = file => {
        if (required.has(file)) return;
        required.add(file);
        for (const edge of outputs[file].imports) if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
    };
    visit(Object.keys(outputs).find(file => outputs[file].entryPoint === entry));
    const isBootstrap = file => file.endsWith('/hostedHtmlGuestBootstrap.generated.ts');
    assert.ok(Object.keys(metafile.inputs).some(isBootstrap), 'hosted demand must retain the real SDK guest bootstrap');
    assert.deepEqual([...required].flatMap(file => Object.keys(outputs[file].inputs)).filter(isBootstrap), [],
        'importing the document builder must not download the guest runtime');
});

test('Account and usage presentation contracts do not download the bundled model-price snapshot', async () => {
    const { metafile } = await build({
        absWorkingDir: repoRoot,
        entryPoints: [
            'packages/protocol/src/account/settings/accountSettings.ts',
            'packages/protocol/src/usage/usageAnalyticsContracts.ts',
            'packages/protocol/src/usage/usageAggregation.ts',
        ],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        conditions: ['happier-source'],
        outdir: '.price-contract-probe',
        write: false,
        metafile: true,
        logLevel: 'silent',
    });
    const snapshots = Object.keys(metafile.inputs).filter(file => file.endsWith('/usageModelPriceSnapshot.ts'));
    assert.deepEqual(snapshots, [], 'settings validation and witnessed cost presentation must not load optional pricing data');
});

for (const [feature, entry, dependency] of [
    ['billing', 'apps/ui/sources/sync/domains/purchases/revenueCat.web.ts', /\/node_modules\/@revenuecat\/purchases-js\//],
    ['voice', 'packages/plugins/elevenlabs/src/ui/voice/runtime/conversationHandle.ts', /\/node_modules\/(?:@elevenlabs\/client|livekit-client)\//],
]) {
    test(`${feature} adapter keeps its browser SDK outside the static entry graph`, async () => {
        const { metafile } = await build({
            absWorkingDir: repoRoot,
            entryPoints: [entry],
            bundle: true,
            splitting: true,
            format: 'esm',
            platform: 'browser',
            outdir: '.feature-dependency-probe',
            write: false,
            metafile: true,
            // Native platform code is a system boundary, not part of this
            // browser-SDK demand contract; its Flow syntax is not esbuild TS.
            external: ['@happier-dev/plugin-sdk/*', 'react-native'],
            logLevel: 'silent',
        });
        const outputs = metafile.outputs;
        const entryOutput = Object.keys(outputs).find((file) => outputs[file].entryPoint === entry);
        assert.ok(entryOutput, 'the real adapter must produce an entry output');
        const required = new Set();
        const visit = (file) => {
            if (required.has(file)) return;
            required.add(file);
            for (const edge of outputs[file].imports) {
                if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
            }
        };
        visit(entryOutput);
        const matchesSdk = (file) => dependency.test('/' + file.replaceAll('\\', '/'));
        assert.ok(Object.keys(metafile.inputs).some(matchesSdk), 'the async graph must retain the real browser SDK');
        const eager = [...required].flatMap((file) => Object.keys(outputs[file].inputs)).filter(matchesSdk);
        console.log(JSON.stringify({ feature, eagerSdkModules: eager.length }));
        assert.deepEqual(eager, [], 'importing the adapter must not require downloading its browser SDK');
    });
}

function collectUiWebGraph(entries, platform = 'web') {
    const sourceRoot = join(repoRoot, 'apps/ui/sources');
    const graph = new Map();
    const visitSource = file => {
        if (graph.has(file)) return;
        const edges = [];
        graph.set(file, edges);
        const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
            fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX },
        });
        const source = ts.createSourceFile(file + '.js', outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const inspect = node => {
            let specifier;
            let dynamic = false;
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
            else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                specifier = node.arguments[0];
                dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            }
            if (specifier && ts.isStringLiteral(specifier)) {
                const path = specifier.text;
                const base = path.startsWith('@/') ? join(sourceRoot, path.slice(2))
                    : path.startsWith('.') ? resolve(dirname(file), path) : null;
                if (base?.startsWith(sourceRoot)) {
                    const resolved = resolveUiSource(file, base, platform);
                    const dependency = resolved?.type === 'sourceFile' && /\.[cm]?[jt]sx?$/.test(resolved.filePath)
                        ? resolved.filePath : null;
                    if (dependency) { edges.push({ file: dependency, dynamic }); visitSource(dependency); }
                }
            }
            ts.forEachChild(node, inspect);
        };
        inspect(source);
    };
    entries.forEach(file => visitSource(join(repoRoot, file)));
    const required = new Set();
    const visit = file => {
        if (required.has(file)) return;
        required.add(file);
        for (const edge of graph.get(file)) if (!edge.dynamic) visit(edge.file);
    };
    entries.forEach(file => visit(join(repoRoot, file)));
    return { graph, required };
}

test('session presentation consumers share one demand boundary instead of eagerly importing the transcript', async () => {
    const entries = [
        'components/onboarding/tour/stage/StageSessionDetail.tsx',
        'components/workspaceCockpit/session/SessionCockpitSurfaceScreen.tsx',
        'components/sessions/panes/SessionInPane.tsx',
        'components/sessions/shell/SessionDestinationBody.tsx',
        'components/sessions/shell/embedded/EmbeddedSessionProvider.tsx',
    ].map(file => `apps/ui/sources/${file}`);
    // Inspect emitted value imports, not TS type references. The final Metro export
    // remains the download-size oracle; this focused graph check needs no native SDK.
    const { graph, required } = collectUiWebGraph(entries);
    const isTranscript = file => file.endsWith('/components/sessions/shell/SessionView.tsx');
    assert.ok([...graph.keys()].some(isTranscript), 'demand must retain the real session implementation');
    const eager = [...required].filter(isTranscript);
    assert.deepEqual(eager, [], 'unopened session presentation must not download the transcript implementation');
    const demandEdges = [...graph.values()].flat().filter(edge => isTranscript(edge.file));
    assert.equal(demandEdges.length, 1, 'all consumers must share one implementation demand edge');
    console.log(JSON.stringify({ feature: 'session', eagerTranscriptModules: eager.length }));
});


test('Home keeps unopened panes, fixtures and builtin widget bodies outside its static UI graph', () => {
    const { graph, required } = collectUiWebGraph([
        'apps/ui/index.ts',
        'apps/ui/sources/app/_layout.tsx',
        'apps/ui/sources/app/(app)/_layout.tsx',
        'apps/ui/sources/app/(app)/index.tsx',
    ]);
    const closed = [
        '/components/appShell/panes/PaneTabDestination.tsx',
        '/components/projects/widgets/ProjectBuiltinWidgetBody.tsx',
        '/components/settings/usage/widgets/UsageWidgetBody.tsx',
        '/components/sessions/panes/SessionDetailsPanel.tsx',
        '/dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition.ts',
    ];
    for (const suffix of closed) {
        assert.ok([...graph.keys()].some(file => file.endsWith(suffix)), `demand retains ${suffix}`);
        assert.deepEqual([...required].filter(file => file.endsWith(suffix)), [], `Home must not download unopened ${suffix}`);
    }
    console.log(JSON.stringify({ feature: 'Home', requiredUiModules: required.size, closedBodies: closed.length }));
});

test('native pane, fixture and builtin widget hosts keep their bodies synchronous', () => {
    const hosts = [
        'components/appShell/panes/PaneTabDestination',
        'components/projects/widgets/ProjectBuiltinWidgetBody',
        'components/settings/usage/widgets/UsageWidgetBody',
        'components/sessions/panes/SessionDetailsPanel',
    ].map(host => [host + 'Host', host + '.tsx']);
    hosts.push(['voice/qa/VoiceSurfaceFixtureHost', 'dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition.ts']);
    for (const platform of ['ios', 'android']) {
        for (const [host, implementation] of hosts) {
            const origin = join(repoRoot, 'apps/ui/index.ts');
            const body = join(repoRoot, 'apps/ui/sources', implementation);
            const resolved = resolveUiSource(origin, join(repoRoot, 'apps/ui/sources', host), platform);
            assert.equal(resolved?.type, 'sourceFile');
            const { outputText } = ts.transpileModule(readFileSync(resolved.filePath, 'utf8'), {
                fileName: resolved.filePath, compilerOptions: { module: ts.ModuleKind.ESNext },
            });
            const source = ts.createSourceFile('host.js', outputText, ts.ScriptTarget.Latest, true);
            const targets = source.statements.filter(node => ts.isExportDeclaration(node) && node.moduleSpecifier)
                .map(node => resolveUiSource(resolved.filePath, node.moduleSpecifier.text, platform)?.filePath);
            assert.ok(targets.includes(body), `${platform} ${host} must synchronously export its incumbent body`);
        }
    }
});

test('web clipboard controls do not load native Action approval or execution', () => {
    const origin = join(repoRoot, 'apps/ui/sources/components/ui/lists/Item.tsx');
    const entry = resolveUiSource(origin, '@/hooks/ui/useClipboardWrite', 'web');
    assert.equal(entry?.type, 'sourceFile');
    const { required } = collectUiWebGraph([relative(repoRoot, entry.filePath)]);
    const actionModules = [...required].filter(file => /\/(?:components\/approvals|sync\/ops\/actions)\//.test(file));
    console.log(JSON.stringify({ feature: 'web clipboard', staticUiModules: required.size, nativeActionModules: actionModules.length }));
    assert.deepEqual(actionModules, [], 'web copy must retain the click-stack clipboard path without native Action custody');
    const nativeEntry = resolveUiSource(origin, '@/hooks/ui/useClipboardWrite', 'ios');
    assert.equal(nativeEntry?.type, 'sourceFile');
    assert.equal(nativeEntry.filePath, join(repoRoot, 'apps/ui/sources/hooks/ui/useClipboardWrite.ts'),
        'native controls retain the mounted Account and approval owner');
});

for (const platform of ['web', 'ios', 'android']) test(`${platform === 'web' ? 'collection presentation' : 'private presentation owner'} defers substantial rich renderers and keeps small presenters synchronous (${platform})`, () => {
    const entry = platform === 'web'
        ? 'apps/ui/sources/components/ui/lists/collection/CoreCollectionScope.tsx'
        : 'apps/ui/sources/components/plugins/surfaces/pluginUiPrivateContent.tsx';
    const { graph, required } = collectUiWebGraph([entry], platform);
    const content = [
        '/plugins/surfaces/PluginUiMarkdown.tsx',
        '/ui/code/diff/DiffViewer.tsx',
        '/ui/code/diff/prose/ProseDiffViewer.tsx',
    ];
    if (platform === 'web') content.push('/ui/media/stage/MediaStage.tsx');
    const matchesContent = (file, suffix) => file.replace(/\.(?:web|ios|android|native)(?=\.[^.]+$)/, '').endsWith(suffix);
    const eager = [...required].filter(file => content.some(suffix => matchesContent(file, suffix)));
    console.log(JSON.stringify({ feature: 'collection presentation', platform, entry, staticUiModules: required.size,
        staticUiSourceBytes: [...required].reduce((sum, file) => sum + statSync(file).size, 0),
        eagerPresenters: eager.map(file => relative(repoRoot, file)) }));
    // Native navigation already reaches the diff bodies independently (the approved simplicity review).
    // Preserve demand at this owner without asserting that it controls those other native entry paths.
    const owner = join(repoRoot, 'apps/ui/sources/components/plugins/surfaces/pluginUiPrivateContent.tsx');
    for (const suffix of ['/plugins/surfaces/PluginUiMarkdown.tsx',
        '/plugins/surfaces/PluginUiPrivateDiffViewer.tsx', '/ui/code/diff/prose/ProseDiffViewer.tsx']) {
        const edges = graph.get(owner).filter(edge => matchesContent(edge.file, suffix));
        assert.equal(edges.length, 1, `one canonical renderer boundary: ${suffix}`);
        assert.ok(edges[0].dynamic, `rich renderer stays on demand at its owner: ${suffix}`);
    }
    assert.deepEqual(platform === 'web' ? eager : eager.filter(file => matchesContent(file,
        '/plugins/surfaces/PluginUiMarkdown.tsx')), [], 'the scope excludes rich bodies not reached independently');
    // Approved presenter-static-revert-1106: these overlapping small graphs render synchronously.
    for (const suffix of ['/ui/code/blocks/CodeBlockView.tsx', '/plugins/surfaces/PluginVoicePresence.tsx',
        '/plugins/surfaces/PluginDictationButton.tsx']) {
        assert.ok([...required].some(file => matchesContent(file, suffix)), `small presenter is synchronous: ${suffix}`);
    }
    for (const suffix of content) assert.ok([...graph.keys()].some(file => matchesContent(file, suffix)),
        `real presentation demand must retain ${suffix}`);
});


test('mounted native Action approval summaries do not import their preview Card', () => {
    const entry = 'apps/ui/sources/components/approvals/useActionApprovalContinuation.ts';
    const { graph } = collectUiWebGraph([entry], 'ios');
    const cards = graph.get(join(repoRoot, entry)).filter(edge => !edge.dynamic
        && edge.file.endsWith('/approvals/ApprovalPreviewCard.tsx'));
    console.log(JSON.stringify({ feature: 'native approval summary read', eagerPreviewCardEdges: cards.length }));
    assert.deepEqual(cards, [], 'summary reads use the presentation owner without acquiring the preview UI');
});


test('native receipt opener does not import unopened detail UI or Action executors', () => {
    const { graph, required } = collectUiWebGraph([
        'apps/ui/sources/components/inbox/actionOperations/openActionOperationDetail.ts',
    ], 'ios');
    const detail = file => file.endsWith('/actionOperations/ActionOperationDetailModal.tsx');
    assert.ok([...graph.keys()].some(detail), 'opening a receipt retains its real detail body');
    const eagerBodies = [...required].filter(file => detail(file) || file.endsWith('/sync/ops/actions/defaultActionExecutor.ts'));
    console.log(JSON.stringify({ feature: 'native receipt opener', staticUiModules: required.size, eagerBodies: eagerBodies.length }));
    assert.deepEqual(eagerBodies, [], 'mounting native controls must not acquire unopened receipt detail UI');
});
