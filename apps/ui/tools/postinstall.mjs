import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import { resolveUiPostinstallTasks } from './resolveUiPostinstallTasks.mjs';
import { buildPasswordKdfWorker } from './password/buildPasswordKdfWorker.mjs';
import { buildCryptoWorker } from './crypto/buildCryptoWorker.mjs';
import { buildAtmosphereRenderers, buildNativeGlyphTypeface } from './atmosphere/buildAtmosphereRenderers.mjs';
import { runCommandBestEffort, runCommandOrExit } from './postinstall/runCommand.mjs';
import { verifyNativePatchCompilation } from './postinstall/verifyNativePatchCompilation.mjs';
import { findUiInstalledPackageDirs } from './postinstall/installedPackageDirs.mjs';
import {
    formatVendoredLegendPatchFailure,
    verifyVendoredLegendPatchMarkers,
} from './postinstall/verifyVendoredLegendPatchMarkers.mjs';
import {
    formatVendoredReanimatedPatchFailure,
    verifyVendoredReanimatedPatchMarkers,
} from './postinstall/verifyVendoredReanimatedPatchMarkers.mjs';
import {
    findReactNativeEnrichedMarkdownPackageDirs,
    formatReactNativeEnrichedMarkdownWebStreamingPatchFailure,
    verifyReactNativeEnrichedMarkdownWebStreamingPatch,
    verifyUiPatchedDependencies,
} from './postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';

// Workspace installs can execute this script via a symlinked path (e.g. repoRoot/node_modules/happy/...).
// Resolve symlinks so expoAppDir is computed from the real filesystem location.
const toolsDir = path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url)));
const expoAppDir = path.resolve(toolsDir, '..');

const installedPackageDirs = (packageName) => findUiInstalledPackageDirs(packageName, { uiPackageDir: expoAppDir });

const tasks = resolveUiPostinstallTasks({ env: process.env });
const wants = (id) => tasks.includes(id);

// Expo serves public/ in development and copies it into web/Tauri exports.
// Explicit full asset preparation is strict. Dependency-only refresh skips
// these tasks; the UI source owner prepares its independent last-green assets.
if (wants('vendor-password-kdf-worker')) {
    await buildPasswordKdfWorker();
}
if (wants('vendor-crypto-worker')) await buildCryptoWorker();
if (wants('prepare-atmosphere-renderers')) {
    await buildAtmosphereRenderers({ web: wants('vendor-password-kdf-worker') });
    await buildNativeGlyphTypeface();
}

// pnpm installs the patches before lifecycle scripts. Prepare the owned WASM
// output, then verify installed artifacts without a second patch writer.
prepareEnrichedMarkdownOutputs();

if (wants('verify-sentry-native-replay-postinit-patch')) {
    const marker = 'HAPPIER PATCH(sentry-native-replay-postinit-guard)';
    const sentryNativeStartCandidatePaths = installedPackageDirs('@sentry/react-native').flatMap((packageDir) => [
        path.resolve(packageDir, 'ios', 'RNSentryStart.m'),
        path.resolve(packageDir, 'ios', 'RNSentry.mm'),
    ]);
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

// The reanimated settled-updates fix is the one patch in this repository that NOTHING else can
// observe: it lives in a dependency's C++, is reached through a native timer race, and when the hunk
// is lost every first-party test still passes while animated values silently stick at stale
// positions. Verify it after pnpm installs the patches: regeneration from an incomplete
// edit directory can still omit the fix while producing a syntactically valid patch.
if (wants('verify-vendored-reanimated-patch')) {
    const reanimatedPackageDirs = installedPackageDirs('react-native-reanimated');
    const appPackageJsonPath = path.resolve(expoAppDir, 'package.json');

    const failureReports = [];
    for (const packageDir of reanimatedPackageDirs) {
        const result = verifyVendoredReanimatedPatchMarkers({ packageDir, appPackageJsonPath });
        // Every installed copy must carry the fix: Metro and the native build resolve independently,
        // so a patched root copy does not vindicate an unpatched app-local one.
        if (result.status === 'failed') {
            failureReports.push(`${packageDir}\n${formatVendoredReanimatedPatchFailure(result)}`);
        }
    }

    if (failureReports.length > 0) {
        console.error(`\n${failureReports.join('\n\n')}\n`);
        process.exit(1);
    }
}

// Like the reanimated guard, verify the installed behavior rather than trusting
// successful patch generation or application to prove that every fix survived.
if (wants('verify-vendored-legend-patch')) {
    const legendPackageDirs = installedPackageDirs('@legendapp/list');

    const failureReports = [];
    for (const packageDir of legendPackageDirs) {
        const result = verifyVendoredLegendPatchMarkers({ packageDir });
        // Every installed copy must carry the markers: Metro and the native build resolve independently,
        // so a patched root copy does not vindicate an unpatched app-local one.
        //
        // Fail on anything that is not explicitly OK or a legitimate skip, rather than matching a
        // status name. This guard reports 'missing' where its reanimated sibling reports 'failed', and
        // an `=== 'failed'` check copied across from that sibling passes a dropped marker silently —
        // measured, not hypothetical. Allow-listing the safe outcomes also fails closed if a future
        // status is added.
        if (result.status !== 'ok' && result.status !== 'skipped') {
            failureReports.push(`${packageDir}\n${formatVendoredLegendPatchFailure(result)}`);
        }
    }

    if (failureReports.length > 0) {
        console.error(`\n${failureReports.join('\n\n')}\n`);
        process.exit(1);
    }
}

function prepareEnrichedMarkdownOutputs() {
    if (wants('install-react-native-enriched-markdown-web-wasm')) {
        const packageDirs = findReactNativeEnrichedMarkdownPackageDirs({ expoAppDir });
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
        const packageDirs = findReactNativeEnrichedMarkdownPackageDirs({ expoAppDir });

        if (packageDirs.length === 0) {
            console.error('Could not find react-native-enriched-markdown under repo or UI node_modules.');
            process.exit(1);
        }

        const failureReports = [];
        for (const packageDir of packageDirs) {
            const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir });
            if (result.status !== 'ok') {
                failureReports.push(`${packageDir}\n${formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(result)}`);
            }
        }

        if (failureReports.length > 0) {
            console.error(`\n${failureReports.join('\n\n')}\n`);
            process.exit(1);
        }
    }
}

if (wants('verify-patched-dependencies')) verifyUiPatchedDependencies({ uiPackageDir: expoAppDir });

if (wants('verify-expo-router-web-modal-patch')) {
    const expoRouterPackageRoots = installedPackageDirs('expo-router');
    const expoRouterPatchTargets = [
        {
            relativePath: ['build', 'layouts', '_web-modal.js'],
            markers: ['ExperimentalModalStack'],
        },
        {
            relativePath: ['build', 'modal', 'web', 'ModalStack.js'],
            markers: [
                'preloadedRoutes: state.preloadedRoutes ?? []',
                'function ModalStackNavigator({ initialRouteName, children, layout, screenOptions, UNSTABLE_router, })',
                '        layout,\n        screenOptions,',
            ],
        },
        {
            relativePath: ['build', 'modal', 'web', 'ModalStackRouteDrawer.js'],
            markers: [
                'HAPPIER PATCH(expo-router-web-modal-critical-inline-layout)',
                'criticalDrawerContentStyle',
                'criticalModalDesktopStyle',
                'criticalModalBodyStyle',
                'HAPPIER PATCH(expo-router-web-modal-first-commit-mount)',
                '<vaul_1.Drawer.Portal container={portalContainer}>',
            ],
        },
        {
            relativePath: ['build', 'modal', 'web', 'utils.js'],
            markers: [
                'HAPPIER PATCH(expo-router-web-modal-first-commit-mount)',
                'useState(() => readIsDesktop(isWeb, breakpoint))',
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
    const skiaSetupCliCandidatePaths = installedPackageDirs('@shopify/react-native-skia')
        .map((packageDir) => path.resolve(packageDir, 'scripts', 'setup-canvaskit.js'));
    const skiaSetupCliPath = skiaSetupCliCandidatePaths.find((candidatePath) =>
        fs.existsSync(candidatePath),
    );

    if (!skiaSetupCliPath) {
        console.error(
            `Could not find the React Native Skia web setup CLI at:\n${skiaSetupCliCandidatePaths
                .map((candidatePath) => `- ${candidatePath}`)
                .join('\n')}`,
        );
        process.exit(1);
    }

    runCommandOrExit({
        command: process.execPath,
        args: [skiaSetupCliPath, 'public'],
        options: { cwd: expoAppDir },
    });
}

// Vendor Monaco static assets for web/desktop code editor. Metro can't bundle Monaco workers reliably, so we serve
// the minified `vs/` directory as static files and load via AMD loader at runtime.
if (wants('vendor-monaco')) {
    try {
        const monacoCandidateDirs = installedPackageDirs('monaco-editor');
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

if (wants('vendor-pdfjs')) {
    const { vendorPdfjs } = await import('./pdfjs/vendorPdfjs.mjs');
    await vendorPdfjs({ expoAppDir });
}
if (wants('vendor-pdfjs-webview-bundle')) {
    const { buildPdfjsWebViewBundle } = await import('./pdfjs/buildPdfjsWebViewBundle.mjs');
    await buildPdfjsWebViewBundle({ expoAppDir });
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
