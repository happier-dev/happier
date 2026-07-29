import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import url from 'node:url';
import { resolveUiPostinstallTasks } from './resolveUiPostinstallTasks.mjs';
import { ensureNohoistPeerLinks } from './ensureNohoistPeerLinks.mjs';
import { runCommandBestEffort, runCommandOrExit } from './postinstall/runCommand.mjs';
import { verifyNativePatchCompilation } from './postinstall/verifyNativePatchCompilation.mjs';

// Yarn workspaces can execute this script via a symlinked path (e.g. repoRoot/node_modules/happy/...).
// Resolve symlinks so repoRootDir/expoAppDir are computed from the real filesystem location.
const toolsDir = path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url)));
const expoAppDir = path.resolve(toolsDir, '..');

function findRepoRoot(startDir) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
        if (
            fs.existsSync(path.resolve(dir, 'package.json')) &&
            fs.existsSync(path.resolve(dir, 'yarn.lock'))
        ) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Fallback: historic layout had the app at repoRoot/expo-app.
    return path.resolve(startDir, '..');
}

const repoRootDir = findRepoRoot(expoAppDir);
const patchDir = path.resolve(expoAppDir, 'patches');
const patchDirFromRepoRoot = path.relative(repoRootDir, patchDir);
const patchDirFromExpoApp = path.relative(expoAppDir, patchDir);
const repoRootNodeModulesDir = path.resolve(repoRootDir, 'node_modules');
const expoAppNodeModulesDir = path.resolve(expoAppDir, 'node_modules');

try {
    ensureNohoistPeerLinks({ repoRootDir, expoAppDir });
} catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
}

const patchPackageCliCandidatePaths = [
    path.resolve(expoAppDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
    path.resolve(repoRootDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
];

const patchPackageCliPath = patchPackageCliCandidatePaths.find((candidatePath) =>
    fs.existsSync(candidatePath),
);

if (!patchPackageCliPath) {
    console.error(
        `Could not find patch-package CLI at:\n${patchPackageCliCandidatePaths
            .map((p) => `- ${p}`)
            .join('\n')}`,
    );
    process.exit(1);
}

const tasks = resolveUiPostinstallTasks({ env: process.env });
const wants = (id) => tasks.includes(id);

function listPatchFiles(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

function resolvePatchTargetPackageName(patchFileName) {
    const raw = patchFileName.endsWith('.patch') ? patchFileName.slice(0, -'.patch'.length) : patchFileName;
    const parts = raw.split('+').filter(Boolean);
    if (parts.length < 2) return '';
    if (parts[0].startsWith('@')) {
        if (parts.length < 3) return '';
        return `${parts[0]}/${parts[1]}`;
    }
    return parts[0];
}

function packageExists(nodeModulesDir, packageName) {
    if (!nodeModulesDir || !packageName) return false;
    return fs.existsSync(path.resolve(nodeModulesDir, packageName));
}

function findReactNativeEnrichedMarkdownPackageDirs() {
    return [
        path.resolve(repoRootNodeModulesDir, 'react-native-enriched-markdown'),
        path.resolve(expoAppNodeModulesDir, 'react-native-enriched-markdown'),
    ].filter((packageDir) => fs.existsSync(packageDir));
}

function createFilteredPatchDir({ patchDir: inputPatchDir, nodeModulesDir, label }) {
    const patchFiles = listPatchFiles(inputPatchDir);
    if (patchFiles.length === 0) return '';

    const selected = patchFiles.filter((fileName) => {
        const pkgName = resolvePatchTargetPackageName(fileName);
        return packageExists(nodeModulesDir, pkgName);
    });

    if (selected.length === 0) return '';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `happier-ui-patches-${label}-`));
    for (const fileName of selected) {
        fs.copyFileSync(path.resolve(inputPatchDir, fileName), path.resolve(tmpDir, fileName));
    }
    return tmpDir;
}

if (wants('patch-package')) {
    // Note: this repo uses Yarn workspaces, so some dependencies are hoisted to the repo root.
    // patch-package only patches packages present in the current working directory's
    // node_modules, so we run it from the repo root but keep patch files in expo-app/patches.
    if (fs.existsSync(repoRootNodeModulesDir)) {
        const filteredPatchDir = createFilteredPatchDir({ patchDir, nodeModulesDir: repoRootNodeModulesDir, label: 'root' });
        if (filteredPatchDir) {
            runCommandOrExit({
                command: process.execPath,
                args: [patchPackageCliPath, '--patch-dir', path.relative(repoRootDir, filteredPatchDir)],
                options: { cwd: repoRootDir },
            });
        }
    }

    // Some dependencies are not hoisted (e.g. expo-router) and are installed under expo-app/node_modules.
    // Run patch-package again scoped to expo-app to apply those patches.
    if (fs.existsSync(expoAppNodeModulesDir)) {
        const filteredPatchDir = createFilteredPatchDir({ patchDir, nodeModulesDir: expoAppNodeModulesDir, label: 'ui' });
        if (filteredPatchDir) {
            runCommandOrExit({
                command: process.execPath,
                args: [patchPackageCliPath, '--patch-dir', path.relative(expoAppDir, filteredPatchDir)],
                options: { cwd: expoAppDir },
            });
        }
    }
}

if (wants('verify-sentry-native-replay-postinit-patch')) {
    const marker = 'HAPPIER PATCH(sentry-native-replay-postinit-guard)';
    const sentryNativeStartCandidatePaths = [
        path.resolve(repoRootNodeModulesDir, '@sentry', 'react-native', 'ios', 'RNSentryStart.m'),
        path.resolve(repoRootNodeModulesDir, '@sentry', 'react-native', 'ios', 'RNSentry.mm'),
        path.resolve(expoAppNodeModulesDir, '@sentry', 'react-native', 'ios', 'RNSentryStart.m'),
        path.resolve(expoAppNodeModulesDir, '@sentry', 'react-native', 'ios', 'RNSentry.mm'),
    ];
    const existingSentryNativeStartPaths = sentryNativeStartCandidatePaths.filter((candidatePath) =>
        fs.existsSync(candidatePath),
    );

    if (existingSentryNativeStartPaths.length === 0) {
        console.error(
            `Could not find @sentry/react-native iOS native start source at:\n${sentryNativeStartCandidatePaths
                .map((p) => `- ${p}`)
                .join('\n')}`,
        );
        process.exit(1);
    }

    const unpatchedPaths = [];
    for (const filePath of existingSentryNativeStartPaths) {
        const contents = fs.readFileSync(filePath, 'utf8');
        const markerIndex = contents.indexOf(marker);
        const guardIndex = contents.indexOf('if (isSessionReplayEnabled)', markerIndex);
        const postInitIndex = contents.indexOf('[RNSentryReplay postInit]', guardIndex);

        if (markerIndex < 0 || guardIndex <= markerIndex || postInitIndex <= guardIndex) {
            unpatchedPaths.push(filePath);
        }
    }

    if (unpatchedPaths.length > 0) {
        console.error(
            `Sentry native replay postInit patch does not appear to be applied to:\n${unpatchedPaths
                .map((p) => `- ${p}`)
                .join('\n')}`,
        );
        process.exit(1);
    }
}

if (wants('verify-native-patch-compilation')) {
    const { ok, errors, warnings } = verifyNativePatchCompilation({ uiDir: expoAppDir });
    for (const warning of warnings) {
        console.warn(`\n[native-patch-compilation] ${warning}\n`);
    }
    if (!ok) {
        console.error(`\n${errors.join('\n\n')}\n`);
        process.exit(1);
    }
}

if (wants('install-react-native-enriched-markdown-web-wasm')) {
    const packageDirs = findReactNativeEnrichedMarkdownPackageDirs();
    const vendoredWasmModulePath = path.resolve(
        toolsDir,
        'react-native-enriched-markdown',
        'md4c.esm.single-file.js',
    );

    if (!fs.existsSync(vendoredWasmModulePath)) {
        console.error(`Could not find vendored react-native-enriched-markdown WASM module at ${vendoredWasmModulePath}`);
        process.exit(1);
    }

    for (const packageDir of packageDirs) {
        const sourceTargetPath = path.resolve(packageDir, 'src', 'web', 'wasm', 'md4c.js');
        const builtTargetPath = path.resolve(packageDir, 'lib', 'module', 'web', 'wasm', 'md4c.js');
        fs.mkdirSync(path.dirname(sourceTargetPath), { recursive: true });
        fs.mkdirSync(path.dirname(builtTargetPath), { recursive: true });
        fs.copyFileSync(vendoredWasmModulePath, sourceTargetPath);
        fs.copyFileSync(vendoredWasmModulePath, builtTargetPath);
    }
}

if (wants('verify-react-native-enriched-markdown-web-streaming-patch')) {
    const packageDirs = findReactNativeEnrichedMarkdownPackageDirs();

    if (packageDirs.length === 0) {
        console.error('Could not find react-native-enriched-markdown under repo or UI node_modules.');
        process.exit(1);
    }

    const unpatchedPaths = [];
    for (const packageDir of packageDirs) {
        const enrichedMarkdownTextPath = path.resolve(packageDir, 'lib', 'module', 'web', 'EnrichedMarkdownText.js');
        const streamingRevealPath = path.resolve(packageDir, 'lib', 'module', 'web', 'streamingReveal.js');
        const parseMarkdownPath = path.resolve(packageDir, 'lib', 'module', 'web', 'parseMarkdown.js');
        const parseMarkdownSourcePath = path.resolve(packageDir, 'src', 'web', 'parseMarkdown.ts');
        const enrichedMarkdownTextSourcePath = path.resolve(packageDir, 'src', 'web', 'EnrichedMarkdownText.tsx');
        const wasmBuildScriptPath = path.resolve(packageDir, 'cpp', 'wasm', 'build.sh');
        const wasmSourceModulePath = path.resolve(packageDir, 'src', 'web', 'wasm', 'md4c.js');
        const wasmBuiltModulePath = path.resolve(packageDir, 'lib', 'module', 'web', 'wasm', 'md4c.js');
        const iosTailFadeAnimatorPath = path.resolve(packageDir, 'ios', 'utils', 'ENRMTailFadeInAnimator.m');
        const androidTailFadeAnimatorPath = path.resolve(packageDir, 'android', 'src', 'main', 'java', 'com', 'swmansion', 'enriched', 'markdown', 'utils', 'text', 'TailFadeInAnimator.kt');

        if (
            !fs.existsSync(enrichedMarkdownTextPath)
            || !fs.existsSync(streamingRevealPath)
            || !fs.existsSync(parseMarkdownPath)
            || !fs.existsSync(parseMarkdownSourcePath)
            || !fs.existsSync(enrichedMarkdownTextSourcePath)
            || !fs.existsSync(wasmBuildScriptPath)
            || !fs.existsSync(wasmSourceModulePath)
            || !fs.existsSync(wasmBuiltModulePath)
            || !fs.existsSync(iosTailFadeAnimatorPath)
            || !fs.existsSync(androidTailFadeAnimatorPath)
        ) {
            unpatchedPaths.push(packageDir);
            continue;
        }

        const enrichedMarkdownTextContents = fs.readFileSync(enrichedMarkdownTextPath, 'utf8');
        const streamingRevealContents = fs.readFileSync(streamingRevealPath, 'utf8');
        const parseMarkdownContents = fs.readFileSync(parseMarkdownPath, 'utf8');
        const parseMarkdownSourceContents = fs.readFileSync(parseMarkdownSourcePath, 'utf8');
        const enrichedMarkdownTextSourceContents = fs.readFileSync(enrichedMarkdownTextSourcePath, 'utf8');
        const wasmBuildScriptContents = fs.readFileSync(wasmBuildScriptPath, 'utf8');
        const wasmSourceModuleContents = fs.readFileSync(wasmSourceModulePath, 'utf8');
        const wasmBuiltModuleContents = fs.readFileSync(wasmBuiltModulePath, 'utf8');
        const wasmSourceModuleBytes = fs.readFileSync(wasmSourceModulePath);
        const wasmBuiltModuleBytes = fs.readFileSync(wasmBuiltModulePath);
        const iosTailFadeAnimatorContents = fs.readFileSync(iosTailFadeAnimatorPath, 'utf8');
        const androidTailFadeAnimatorContents = fs.readFileSync(androidTailFadeAnimatorPath, 'utf8');
        if (
            !enrichedMarkdownTextContents.includes('markStreamingRevealOffsets')
            || !enrichedMarkdownTextContents.includes('streamingAnimation')
            || !enrichedMarkdownTextContents.includes('updateStreamingRevealRanges')
            || !parseMarkdownContents.includes('preloadMarkdownRuntime')
            || !parseMarkdownContents.includes("import createMd4cModule from './wasm/md4c.js'")
            || parseMarkdownContents.includes("import('./wasm/md4c")
            || !parseMarkdownContents.includes("['number', 'number', 'number']")
            || !parseMarkdownContents.includes('stringToUTF8(markdown')
            || !parseMarkdownContents.includes('parseCache.clear()')
            || !parseMarkdownSourceContents.includes('lengthBytesUTF8(markdown)')
            || !parseMarkdownSourceContents.includes("import createMd4cModule from './wasm/md4c.js'")
            || parseMarkdownSourceContents.includes("import('./wasm/md4c")
            || !parseMarkdownSourceContents.includes('parserPromise = null')
            || !enrichedMarkdownTextSourceContents.includes('lastChildStyles.paragraph')
            || enrichedMarkdownTextSourceContents.includes('<pre')
            || !wasmBuildScriptContents.includes('STACK_SIZE=8MB')
            || !wasmBuildScriptContents.includes('SINGLE_FILE_BINARY_ENCODE=0')
            || !wasmBuildScriptContents.includes('ALLOW_MEMORY_GROWTH=1')
            || !wasmBuildScriptContents.includes('EXPORT_ES6=1')
            || !wasmBuildScriptContents.includes('"_parseMarkdown","_malloc","_free"')
            || !wasmBuildScriptContents.includes('"stringToUTF8","lengthBytesUTF8"')
            || !wasmSourceModuleContents.includes('export default createMd4cModule')
            || !wasmBuiltModuleContents.includes('export default createMd4cModule')
            || wasmSourceModuleContents.includes('import.meta')
            || wasmBuiltModuleContents.includes('import.meta')
            || wasmSourceModuleBytes.includes(0)
            || wasmBuiltModuleBytes.includes(0)
            || !streamingRevealContents.includes('data-happier-enriched-markdown-reveal')
            || !streamingRevealContents.includes('updateStreamingRevealRanges')
            || !iosTailFadeAnimatorContents.includes('ENRMActiveFadeRange')
            || !androidTailFadeAnimatorContents.includes('activeRanges')
        ) {
            unpatchedPaths.push(packageDir);
        }
    }

    if (unpatchedPaths.length > 0) {
        console.error(
            `react-native-enriched-markdown web streaming patch does not appear to be applied to:\n${unpatchedPaths
                .map((p) => `- ${p}`)
                .join('\n')}`,
        );
        process.exit(1);
    }
}

if (wants('verify-expo-router-web-modal-patch')) {
    const expoRouterPackageRoots = [
        path.resolve(repoRootDir, 'node_modules', 'expo-router'),
        path.resolve(expoAppDir, 'node_modules', 'expo-router'),
    ];
    const expoRouterPatchTargets = [
        {
            relativePath: ['build', 'layouts', '_web-modal.js'],
            markers: ['ExperimentalModalStack'],
        },
        {
            relativePath: ['build', 'modal', 'web', 'ModalStack.js'],
            markers: ['preloadedRoutes: state.preloadedRoutes ?? []'],
        },
        {
            relativePath: ['build', 'modal', 'web', 'ModalStackRouteDrawer.js'],
            markers: [
                'HAPPIER PATCH(expo-router-web-modal-critical-inline-layout)',
                'criticalDrawerContentStyle',
                'criticalModalDesktopStyle',
                'criticalModalBodyStyle',
            ],
        },
        {
            relativePath: ['build', 'fork', 'native-stack', 'createNativeStackNavigator.js'],
            markers: [
                'isLiquidGlassNavigatorAvailable',
                'expo-glass-effect/build/isLiquidGlassAvailable',
            ],
        },
        {
            relativePath: ['build', 'fork', 'useLinking.js'],
            markers: [
                'rollbackHistoryIfPrevented',
                'pendingPopStateDeltaRef',
                'CommonActions.goBack()',
                'HAPPIER PATCH(expo-router-root-focused-history-ownership)',
                'previousState === rootState',
                'const currentState = store.state ?? navigation.getRootState()',
                'previousStateRef.current = rootState',
                'findMatchingState(previousState, rootState)',
            ],
            forbiddenMarkers: ['history.go(historyDelta)'],
        },
        {
            relativePath: ['build', 'fork', 'createMemoryHistory.js'],
            markers: [
                'const foundIndex = pending.findIndex',
                'pending[foundIndex]?.cb()',
                'index = this.index',
            ],
        },
    ];
    const unpatchedPaths = [];
    for (const target of expoRouterPatchTargets) {
        const candidatePaths = expoRouterPackageRoots.map((packageRoot) =>
            path.resolve(packageRoot, ...target.relativePath),
        );
        const existingPaths = candidatePaths.filter((candidatePath) => fs.existsSync(candidatePath));
        if (existingPaths.length === 0) {
            console.error(
                `Could not find expo-router ${target.relativePath.join('/')} at:\n${candidatePaths
                    .map((p) => `- ${p}`)
                    .join('\n')}`,
            );
            process.exit(1);
        }
        for (const filePath of existingPaths) {
            const contents = fs.readFileSync(filePath, 'utf8');
            if (
                target.markers.some((marker) => !contents.includes(marker))
                || target.forbiddenMarkers?.some((marker) => contents.includes(marker))
            ) {
                unpatchedPaths.push(filePath);
            }
        }
    }

    if (unpatchedPaths.length > 0) {
        console.error(
            `expo-router patch does not appear to be applied to:\n${unpatchedPaths
                .map((p) => `- ${p}`)
                .join('\n')}`,
        );
        process.exit(1);
    }
}

if (wants('setup-skia-web')) {
    runCommandOrExit({ command: 'npx', args: ['setup-skia-web', 'public'], options: { cwd: expoAppDir } });
}

// Vendor Monaco static assets for web/desktop code editor. Metro can't bundle Monaco workers reliably, so we serve
// the minified `vs/` directory as static files and load via AMD loader at runtime.
if (wants('vendor-monaco')) {
    try {
        const monacoCandidateDirs = [
            path.resolve(expoAppDir, 'node_modules', 'monaco-editor'),
            path.resolve(repoRootDir, 'node_modules', 'monaco-editor'),
        ];
        const monacoDir = monacoCandidateDirs.find((p) => fs.existsSync(p));
        if (monacoDir) {
            const src = path.resolve(monacoDir, 'min', 'vs');
            const dst = path.resolve(expoAppDir, 'public', 'monaco', 'vs');
            if (fs.existsSync(src)) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.cpSync(src, dst, { recursive: true, force: true });
            }
        }
    } catch (e) {
        // Best-effort: Monaco is an experimental feature and should not break installs.
    }
}

// Vendor Pierre diffs worker assets for web/desktop. Metro can't reliably resolve worker-module URLs for ESM workers,
// so we copy Pierre's "portable worker" bundle into `public/` and load it via `new Worker(url, { type: 'module' })`.
if (wants('vendor-pierre-diffs-worker')) {
    try {
        runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'diffs', 'buildPierreWorker.mjs')],
            options: { cwd: expoAppDir },
        });
    } catch (e) {
        // Best-effort: Pierre diffs have a runtime fallback when workers cannot be created.
    }
}

// Bundle CodeMirror for the native CodeMirror WebView editor. We embed the resulting bundle as a JS string to avoid
// runtime CDN imports (offline + deterministic). Kept best-effort: the editor has a runtime CDN fallback when empty.
if (wants('vendor-codemirror-webview-bundle')) {
    try {
        runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'codemirror', 'buildCodeMirrorWebViewBundle.mjs')],
            options: { cwd: expoAppDir },
        });
    } catch (e) {
        // Best-effort: CodeMirror editor has a runtime fallback when the embedded bundle is missing.
    }
}

// Bundle Xterm for the native terminal WebView. We embed the resulting bundle as a JS string to avoid
// runtime CDN imports (offline + deterministic). Kept best-effort: the terminal can still render an
// error state when the embedded bundle is missing.
if (wants('vendor-xterm-webview-bundle')) {
    try {
        runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'xterm', 'buildXtermWebViewBundle.mjs')],
            options: { cwd: expoAppDir },
        });
    } catch (e) {
        // Best-effort: Xterm is optional and should not break installs.
    }
}

// Bundle TipTap (headless @tiptap/core) for the native rich markdown WebView editor. We embed the
// resulting bundle as a JS string. Unlike CodeMirror/Xterm there is NO CDN fallback (D9): when the
// embedded bundle is missing the native rich editor fails closed to raw mode. The build script
// asserts non-empty output, so a successful run always produces a usable bundle. Kept best-effort:
// the rich editor is an experimental, flag-gated feature and must not break installs (it degrades to
// raw editing when the bundle is absent).
if (wants('vendor-tiptap-webview-bundle')) {
    try {
        runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'tiptap', 'buildTiptapWebViewBundle.mjs')],
            options: { cwd: expoAppDir },
        });
    } catch (e) {
        // Best-effort: the rich markdown editor is experimental and degrades to raw mode without it.
    }
}

// Bundle Mermaid for the native transcript WebView. Product code consumes the
// committed generated fallback and has no CDN or other runtime-network path.
if (wants('vendor-mermaid-webview-bundle')) {
    try {
        const result = runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'mermaid', 'buildMermaidWebViewBundle.mjs')],
            options: { cwd: expoAppDir },
        });
        if (!result.ok) {
            console.warn(
                `[postinstall] Mermaid WebView bundle refresh exited with status ${result.status}; `
                + 'the committed bundle was retained and candidate verification will reject stale bytes.',
            );
        }
    } catch (error) {
        console.warn(
            `[postinstall] Mermaid WebView bundle refresh failed: ${error instanceof Error ? error.message : String(error)}; `
            + 'the committed bundle was retained and candidate verification will reject stale bytes.',
        );
    }
}
