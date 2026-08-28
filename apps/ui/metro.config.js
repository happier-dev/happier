const path = require("node:path");
const fs = require("node:fs");
const {
  getSentryExpoConfig
} = require("@sentry/react-native/metro");

const generatedWorkletModulePrefixes = [
  "react-native-worklets/__generatedWorklets/",
  "react-native-worklets/.worklets/",
];
const workletsPackageName = "react-native-worklets";

function parseBooleanEnv(name, defaultValue) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return defaultValue;
}

const workletsBundleModeEnabled = parseBooleanEnv("HAPPIER_UI_WORKLETS_BUNDLE_MODE", false);
let workletsPackageRoot = null;
try {
  workletsPackageRoot = path.dirname(require.resolve(`${workletsPackageName}/package.json`));
} catch {
  workletsPackageRoot = null;
}

function getWorkletsBundleModeEntryPoints() {
  const entryPoints = [];
  for (const candidate of [
    "react-native-worklets/src/initializers/workletRuntimeEntry.native.ts",
    "react-native-worklets/lib/module/initializers/workletRuntimeEntry.native.js",
  ]) {
    try {
      entryPoints.push(require.resolve(candidate));
    } catch {
      // ignore unavailable package layouts
    }
  }
  return entryPoints;
}

const workletsBundleModeEntryPoints = workletsBundleModeEnabled
  ? getWorkletsBundleModeEntryPoints()
  : [];

function isGeneratedWorkletImport(moduleName) {
  return typeof moduleName === "string"
    && generatedWorkletModulePrefixes.some((prefix) => moduleName.startsWith(prefix));
}

function referencesGeneratedWorkletPath(moduleName) {
  return typeof moduleName === "string"
    && generatedWorkletModulePrefixes.some((prefix) => moduleName.includes(prefix));
}

function resolveGeneratedWorkletModule(moduleName) {
  if (!workletsBundleModeEnabled || !workletsPackageRoot || !isGeneratedWorkletImport(moduleName)) return null;
  const filePath = path.join(workletsPackageRoot, moduleName.slice(`${workletsPackageName}/`.length));
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[Worklets] Generated Worklets Bundle Mode module "${moduleName}" does not exist at "${filePath}". `
      + "This usually means Metro is serving stale worklet transforms or Bundle Mode was toggled without clearing the cache; clear Metro cache before restarting. "
      + "Restart Metro with a cleared cache and keep HAPPIER_UI_WORKLETS_BUNDLE_MODE consistent between Babel and Metro.",
    );
  }
  return {
    type: "sourceFile",
    filePath,
  };
}

function resolveGeneratedWorkletsWatchFolders() {
  if (!workletsBundleModeEnabled || !workletsPackageRoot) return null;
  return generatedWorkletModulePrefixes.map((prefix) => {
    const folder = path.resolve(workletsPackageRoot, prefix.slice(`${workletsPackageName}/`.length));
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      // Metro will surface the underlying filesystem problem if the folder cannot be crawled.
    }
    return folder;
  });
}

function resolveWorkletsRuntimeWatchFolders() {
  if (!workletsBundleModeEnabled || !workletsPackageRoot || workletsBundleModeEntryPoints.length === 0) {
    return null;
  }
  return [workletsPackageRoot];
}

const config = getSentryExpoConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

const existingSerializer = config.serializer || {};
const existingGetModulesRunBeforeMainModule = existingSerializer.getModulesRunBeforeMainModule;
const existingCreateModuleIdFactory = existingSerializer.createModuleIdFactory;
const ORDINARY_MODULE_ID_OFFSET = 1_000_000_000;

function toOrdinaryModuleId(preferredModuleId, fallbackModuleId) {
  const numericPreferred = Number(preferredModuleId);
  if (Number.isSafeInteger(numericPreferred) && numericPreferred >= 0) {
    const shiftedModuleId = numericPreferred + ORDINARY_MODULE_ID_OFFSET;
    if (Number.isSafeInteger(shiftedModuleId)) {
      return shiftedModuleId;
    }
  }
  return fallbackModuleId;
}

config.serializer = {
  ...existingSerializer,
  getModulesRunBeforeMainModule(dirname) {
    const existingModules = typeof existingGetModulesRunBeforeMainModule === "function"
      ? existingGetModulesRunBeforeMainModule(dirname)
      : [];
    return [
      ...workletsBundleModeEntryPoints,
      ...existingModules,
    ];
  },
  createModuleIdFactory() {
    const existingFactory = typeof existingCreateModuleIdFactory === "function"
      ? existingCreateModuleIdFactory()
      : null;
    let nextModuleId = 0;
    let nextOrdinaryModuleId = ORDINARY_MODULE_ID_OFFSET;
    const moduleIdByName = new Map();
    const usedModuleIds = new Set();

    return (moduleName) => {
      if (moduleIdByName.has(moduleName)) return moduleIdByName.get(moduleName);
      if (workletsBundleModeEnabled && referencesGeneratedWorkletPath(moduleName)) {
        const moduleId = Number(path.basename(moduleName, ".js"));
        usedModuleIds.add(moduleId);
        moduleIdByName.set(moduleName, moduleId);
        return moduleId;
      }
      const preferredModuleId = existingFactory ? existingFactory(moduleName) : nextModuleId++;
      let moduleId = workletsBundleModeEnabled
        ? toOrdinaryModuleId(preferredModuleId, nextOrdinaryModuleId)
        : preferredModuleId;
      while (usedModuleIds.has(moduleId)) {
        moduleId += 1;
      }
      if (workletsBundleModeEnabled && moduleId >= nextOrdinaryModuleId) {
        nextOrdinaryModuleId = moduleId + 1;
      }
      usedModuleIds.add(moduleId);
      moduleIdByName.set(moduleName, moduleId);
      return moduleId;
    };
  },
};

// Metro defaults to Watchman (and, when unavailable, falls back to the native `find` crawler). In large monorepos,
// both Watchman and the native `find` crawler can be unreliable in non-interactive "stack/runtime build" contexts:
// - Watchman can hang for ~1 minute per `watch-project` (or fail on sandboxed runners)
// - the native `find` path can exceed Node's max string length and crash
//
// In CI/e2e and stack builds, prefer Metro's Node filesystem crawler (slower but deterministic).
const isStackRun = Boolean((process.env.HAPPIER_STACK_STACK ?? '').toString().trim());
const isWatchmanDisabledForLocalRun = /^(1|true|yes|on)$/i.test(
  (process.env.HAPPIER_UI_METRO_DISABLE_WATCHMAN ?? '').toString().trim(),
);

if (process.env.CI || isStackRun || isWatchmanDisabledForLocalRun) {
  config.resolver.useWatchman = false;
  // `metro-file-map`'s watcher selection is driven by `watcher.useWatchman`, not
  // `resolver.useWatchman`. Set both to avoid "Failed to start watch mode"
  // timeouts in large monorepos where Watchman can be slow to initialize.
  config.watcher = {
    ...(config.watcher || {}),
    useWatchman: false,
  };
}

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');
// Built-in pet packages ship Codex-compatible WebP spritesheets through Metro for web,
// native mobile, and the Tauri desktop web export.
config.resolver.assetExts.push('webp');

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

// Never bundle route-adjacent test/spec files into runtime app bundles.
// They may import Vitest APIs, which crash when executed in Expo runtime.
const testRouteBlockList = /[\\/]sources[\\/]app[\\/].*\.(test|spec)\.[jt]sx?$/;
const projectArtifactsBlockList = /[\\/]\.project[\\/]/;
const nextBuildArtifactsBlockList = /[\\/]\.next[\\/]/;
// Generated directory swaps briefly expose these paths before they are removed. Metro must not crawl them.
const transientGeneratedDirectoriesBlockList = /[\\/](?:\.tmp\.[^\\/]+|dist\.__finalize_backup__\.[^\\/]+)(?:[\\/]|$)/;
// CLI runtime snapshots are generated deployment artifacts, not application inputs. In stack runs,
// Expo watches the CLI workspace and otherwise crawls every retained snapshot on each platform.
const cliRunnerSnapshotsBlockList = /[\\/]apps[\\/]cli[\\/]\.runner-snapshots(?:[\\/]|$)/;
// Avoid scanning duplicate workspace-local `node_modules/**` trees (typically symlink-heavy) when Metro falls back
// to the native `find` crawler (no Watchman). We still keep the monorepo root `node_modules` and `apps/ui/node_modules`.
const workspaceNodeModulesBlockList =
  /[\\/]apps[\\/](?!ui[\\/])[^\\/]+[\\/]node_modules[\\/]|[\\/]packages[\\/][^\\/]+[\\/]node_modules[\\/]/;
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = Array.isArray(existingBlockList)
  ? [...existingBlockList, testRouteBlockList, projectArtifactsBlockList, nextBuildArtifactsBlockList, transientGeneratedDirectoriesBlockList, cliRunnerSnapshotsBlockList, workspaceNodeModulesBlockList]
  : existingBlockList
    ? [existingBlockList, testRouteBlockList, projectArtifactsBlockList, nextBuildArtifactsBlockList, transientGeneratedDirectoriesBlockList, cliRunnerSnapshotsBlockList, workspaceNodeModulesBlockList]
    : [testRouteBlockList, projectArtifactsBlockList, nextBuildArtifactsBlockList, transientGeneratedDirectoriesBlockList, cliRunnerSnapshotsBlockList, workspaceNodeModulesBlockList];

const existingWatchFolders = Array.isArray(config.watchFolders) ? config.watchFolders : [];
config.watchFolders = existingWatchFolders.filter(
  (folder, index, all) => typeof folder === 'string' && folder.length > 0 && all.indexOf(folder) === index,
);

const rootNodeModules = path.resolve(__dirname, "../../node_modules");
const appNodeModules = path.resolve(__dirname, "node_modules");
const enrichedMarkdownStreamingRevealModule =
  "react-native-enriched-markdown/lib/module/web/streamingReveal.js";

function resolvePatchedEnrichedMarkdownModule(moduleName) {
  if (moduleName !== enrichedMarkdownStreamingRevealModule) return null;

  const relativeSegments = enrichedMarkdownStreamingRevealModule.split("/");
  for (const nodeModulesDir of [appNodeModules, rootNodeModules]) {
    const candidate = path.resolve(nodeModulesDir, ...relativeSegments);
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `[EnrichedMarkdown] Required patched module "${enrichedMarkdownStreamingRevealModule}" is missing. `
    + "Run the UI postinstall so the app-owned react-native-enriched-markdown patch is applied.",
  );
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectInternalWorkspacePackages(rootDir, maxDepth = 4) {
  const packages = new Map();

  function visit(dir, depth) {
    if (depth > maxDepth) return;
    const basename = path.basename(dir);
    if (basename === "node_modules" || basename.startsWith(".")) return;

    const packageJson = safeReadJson(path.resolve(dir, "package.json"));
    if (packageJson && typeof packageJson.name === "string" && packageJson.name.startsWith("@happier-dev/")) {
      packages.set(packageJson.name, dir);
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        visit(path.resolve(dir, entry.name), depth + 1);
      }
    }
  }

  visit(rootDir, 0);
  return packages;
}

const internalWorkspacePackages = collectInternalWorkspacePackages(path.resolve(__dirname, "../../packages"));
const internalWorkspaceSourceRoots = [...internalWorkspacePackages.values()]
  .map((packageRoot) => path.resolve(packageRoot, "src"));
const internalWorkspaceDistBlockList = [...internalWorkspacePackages.values()].map((packageRoot) => {
  const normalizedDistPath = path.resolve(packageRoot, "dist").replace(/\\/g, "/");
  const pattern = normalizedDistPath
    .split("/")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  return new RegExp(`${pattern}(?:[\\\\/]|$)`);
});
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  ...internalWorkspaceDistBlockList,
];

function resolvePackageExportTarget(entry, platform) {
  if (typeof entry === "string" && entry.length > 0) return entry;
  if (!entry || typeof entry !== "object") return null;

  const platformEntry = platform === "web"
    ? entry.browser
    : platform
      ? entry["react-native"]
      : null;
  const platformTarget = resolvePackageExportTarget(platformEntry, platform);
  if (platformTarget) return platformTarget;

  return resolvePackageExportTarget(entry.default ?? entry.import ?? entry.require ?? null, platform);
}

function resolveExistingSourceCandidate(basePath) {
  for (const candidate of [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveInternalWorkspaceRelativeSourceImport(originModulePath, moduleName) {
  if (typeof originModulePath !== "string" || typeof moduleName !== "string" || !moduleName.startsWith(".")) {
    return null;
  }

  const candidate = path.resolve(path.dirname(originModulePath), moduleName);
  const extension = path.extname(candidate);
  if (extension !== ".js" && extension !== ".mjs" && extension !== ".cjs") return null;

  const isWorkspaceSource = internalWorkspaceSourceRoots.some(
    (sourceRoot) => candidate === sourceRoot || candidate.startsWith(`${sourceRoot}${path.sep}`),
  );
  if (!isWorkspaceSource) return null;

  return resolveExistingSourceCandidate(candidate.slice(0, -extension.length));
}

function resolveInternalWorkspacePackageSource(moduleName, platform) {
  if (typeof moduleName !== "string" || !moduleName.startsWith("@happier-dev/")) return null;

  const parts = moduleName.split("/");
  if (parts.length < 2) return null;
  const packageName = `${parts[0]}/${parts[1]}`;
  const packageRoot = internalWorkspacePackages.get(packageName);
  if (!packageRoot) return null;

  const packageJson = safeReadJson(path.resolve(packageRoot, "package.json"));
  if (!packageJson) return null;

  const subpath = parts.slice(2).join("/");
  const exportKey = subpath ? `./${subpath}` : ".";
  const exportTarget = resolvePackageExportTarget(
    packageJson.exports?.[exportKey] ?? (!subpath ? packageJson.main : null),
    platform,
  );
  if (typeof exportTarget !== "string") return null;

  const normalizedTarget = exportTarget.replace(/\\/g, "/").replace(/^\.\//u, "");
  if (!normalizedTarget.startsWith("dist/")) return null;

  const sourceRelativeTarget = normalizedTarget.slice("dist/".length);
  const extension = path.extname(sourceRelativeTarget);
  const sourceBasePath = path.resolve(
    packageRoot,
    "src",
    extension ? sourceRelativeTarget.slice(0, -extension.length) : sourceRelativeTarget,
  );
  return resolveExistingSourceCandidate(sourceBasePath);
}

const generatedWorkletsWatchFolders = resolveGeneratedWorkletsWatchFolders() || [];
for (const generatedWorkletsWatchFolder of generatedWorkletsWatchFolders) {
  if (!config.watchFolders.includes(generatedWorkletsWatchFolder)) {
    config.watchFolders.push(generatedWorkletsWatchFolder);
  }
}
const workletsRuntimeWatchFolders = resolveWorkletsRuntimeWatchFolders() || [];
for (const workletsRuntimeWatchFolder of workletsRuntimeWatchFolders) {
  if (!config.watchFolders.includes(workletsRuntimeWatchFolder)) {
    config.watchFolders.push(workletsRuntimeWatchFolder);
  }
}

// Expo packages can be hoisted into the monorepo root `node_modules/**` and ship TypeScript entrypoints.
// Metro needs these files in its watch set to compute SHA-1 hashes during export/build, but we still want
// to avoid watching the entire monorepo `node_modules/**` tree.
const watchedHoistedNodeModuleRoots = [
  path.resolve(rootNodeModules, "expo-modules-core"),
  path.resolve(rootNodeModules, "expo-system-ui"),
];
for (const folder of watchedHoistedNodeModuleRoots) {
  if (!config.watchFolders.includes(folder)) {
    config.watchFolders.push(folder);
  }
}

// `packages/tests` contains UI e2e artifacts under `packages/tests/.project/**` which can grow very large.
// When Metro falls back to the native `find` crawler (e.g. on machines without Watchman), scanning that tree
// can exceed Node's max string length and crash the bundler. The UI runtime never needs to watch this package.
const testsWorkspaceRoot = path.resolve(__dirname, "../../packages/tests");
config.watchFolders = config.watchFolders.filter((folder) => folder !== testsWorkspaceRoot);

// The UI runtime never imports `apps/docs` or `apps/website`, but those workspaces can contain very large build
// artifacts (e.g. `.next/**`). When Metro falls back to the native `find` crawler, scanning them can crash with
// `RangeError: Invalid string length`. Keep them out of the watcher set.
const docsWorkspaceRoot = path.resolve(__dirname, "../docs");
const websiteWorkspaceRoot = path.resolve(__dirname, "../website");
config.watchFolders = config.watchFolders.filter((folder) => folder !== docsWorkspaceRoot && folder !== websiteWorkspaceRoot);

// Kokoro (kokoro-js) ships a `.web.js` prebundle that Metro cannot transform (it contains non-literal dynamic imports).
// For Expo web, force Metro to resolve the package to its ESM entry and shim Node builtins that the ESM file imports
// but never uses in browser mode.
const kokoroEntryPoint = path.resolve(__dirname, "../../node_modules/kokoro-js/dist/kokoro.js");
const nodePathShim = path.resolve(__dirname, "sources/platform/nodeShims/nodePathShim.ts");
const nodeFsPromisesShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeFsPromisesShim.ts");
const nodeFsShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeFsShim.ts");
const nodeOsShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeOsShim.ts");
const nodeUrlShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeUrlShim.ts");
const onnxruntimeWebStub = path.resolve(__dirname, "sources/platform/stubs/onnxruntimeWebStub.ts");
const kokoroJsStub = path.resolve(__dirname, "sources/platform/stubs/kokoroJsStub.ts");
const transformersStub = path.resolve(__dirname, "sources/platform/stubs/huggingfaceTransformersStub.ts");
const fontFaceObserverWebShim = path.resolve(__dirname, "sources/platform/shims/fontFaceObserverWebShim.ts");
const reactNativeWebShim = path.resolve(__dirname, "sources/platform/shims/reactNativeWebShim.ts");
const expoSystemUiWebStub = path.resolve(__dirname, "sources/platform/stubs/expoSystemUiWebStub.ts");
const expoAsyncRequireSetupShim = path.resolve(__dirname, "sources/dev/webHmrOptOut/expoAsyncRequireSetupShim.ts");
const expoMessageSocketShim = path.resolve(__dirname, "sources/dev/webHmrOptOut/expoMessageSocketShim.ts");
const workspaceEntryPoint = path.resolve(__dirname, "index.ts");

function isExpoModuleOrigin(originModulePath, suffixes) {
  const origin = String(originModulePath ?? "");
  if (!origin) return false;

  return suffixes.some((suffix) => {
    const normalizedSuffix = suffix.replace(/\//g, "[\\\\/]");
    const pattern = new RegExp(`[\\\\/]node_modules[\\\\/]expo[\\\\/](?:src|build)[\\\\/]${normalizedSuffix}$`);
    return pattern.test(origin);
  });
}

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const generatedWorkletResolution = resolveGeneratedWorkletModule(moduleName);
  if (generatedWorkletResolution) return generatedWorkletResolution;

  const patchedEnrichedMarkdownModule = resolvePatchedEnrichedMarkdownModule(moduleName);
  if (patchedEnrichedMarkdownModule) {
    return { type: "sourceFile", filePath: patchedEnrichedMarkdownModule };
  }

  // Fix event-target-shim/index import - exports define "." not "./index"
  let resolvedModuleName = moduleName;
  if (moduleName === "event-target-shim/index") {
    resolvedModuleName = "event-target-shim";
  }
  // Some upstream packages import `@noble/hashes/crypto.js`, but noble-hashes only exports `./crypto`.
  // Metro can crash when resolution throws inside a large monorepo watch crawl; normalize to the exported subpath.
  if (moduleName === "@noble/hashes/crypto.js") {
    resolvedModuleName = "@noble/hashes/crypto";
  }
  if (path.normalize(String(moduleName)) === path.resolve(rootNodeModules, "@noble/hashes/crypto.js")) {
    resolvedModuleName = "@noble/hashes/crypto";
  }

  const internalWorkspaceRelativeSourceImport = resolveInternalWorkspaceRelativeSourceImport(
    context?.originModulePath,
    resolvedModuleName,
  );
  if (internalWorkspaceRelativeSourceImport) {
    return { type: "sourceFile", filePath: internalWorkspaceRelativeSourceImport };
  }

  const internalWorkspacePackageSource = resolveInternalWorkspacePackageSource(resolvedModuleName, platform);
  if (internalWorkspacePackageSource) {
    return { type: "sourceFile", filePath: internalWorkspacePackageSource };
  }

  // Per-tab web QA opt-out: allow disabling Fast Refresh/HMR on specific browser tabs (via sessionStorage),
  // without turning it off for all connected clients.
  //
  // Expo's web dev runtime enables Fast Refresh/HMR by importing `expo/src/async-require/setup` very early
  // (via `expo/src/winter/runtime.ts`). We shim that module on web so it can consult a per-tab flag and
  // initialize the HMR client with `isEnabled=false` when opted out (keeps bundle splitting working).
  if (
    platform === "web" &&
    resolvedModuleName === "../async-require/setup" &&
    isExpoModuleOrigin(context?.originModulePath, ["winter/runtime\\.(ts|js)"])
  ) {
    return { type: "sourceFile", filePath: expoAsyncRequireSetupShim };
  }

  // Expo also opens a reload socket from Expo.fx.tsx. Intercept that path too so per-tab QA opt-out
  // suppresses full-page reload commands, not just Fast Refresh/HMR patch delivery.
  if (
    platform === "web" &&
    resolvedModuleName === "./async-require/messageSocket" &&
    isExpoModuleOrigin(context?.originModulePath, ["Expo\\.fx\\.(tsx|js)"])
  ) {
    return { type: "sourceFile", filePath: expoMessageSocketShim };
  }

  if (
    platform === "web" &&
    (resolvedModuleName === "./apps/ui/index.ts" || resolvedModuleName === "apps/ui/index.ts")
  ) {
    return { type: "sourceFile", filePath: workspaceEntryPoint };
  }

  // On web, Expo aliases `react-native` to `react-native-web`, which does not export
  // `unstable_batchedUpdates`. Some libraries (e.g. `@legendapp/list`) import it from
  // `react-native` and crash at runtime. Use a shim that re-exports RNW + adds the missing API.
  if (platform === "web" && resolvedModuleName === "react-native") {
    return { type: "sourceFile", filePath: reactNativeWebShim };
  }

  if (
    platform === "web" &&
    (resolvedModuleName === "@huggingface/transformers" ||
      resolvedModuleName.startsWith("@huggingface/transformers/"))
  ) {
    return { type: "sourceFile", filePath: transformersStub };
  }

  // expo-font uses fontfaceobserver on web with a hard-coded timeout; in practice this can
  // surface as unhandled errors. Use a web-safe shim that avoids throwing on timeouts.
  if (platform === "web" && resolvedModuleName === "fontfaceobserver") {
    return { type: "sourceFile", filePath: fontFaceObserverWebShim };
  }

  // `expo-system-ui` is native-focused; the web bundle does not need to depend on it.
  if (platform === "web" && resolvedModuleName === "expo-system-ui") {
    return { type: "sourceFile", filePath: expoSystemUiWebStub };
  }

  if (resolvedModuleName === "kokoro-js" || resolvedModuleName.startsWith("kokoro-js/")) {
    if (platform === "web") {
      return { type: "sourceFile", filePath: kokoroJsStub };
    }
    return { type: "sourceFile", filePath: kokoroEntryPoint };
  }

  // onnxruntime-web's bundle contains non-literal dynamic imports that Metro cannot parse.
  // Use a stub on web so the UI can export/bundle; kokoro local TTS is not supported on web.
  if (
    platform === "web" &&
    (moduleName === "onnxruntime-web" || moduleName.startsWith("onnxruntime-web/"))
  ) {
    return { type: "sourceFile", filePath: onnxruntimeWebStub };
  }

  if (moduleName === "path") {
    return { type: "sourceFile", filePath: nodePathShim };
  }
  if (moduleName === "node:fs/promises" || moduleName === "fs/promises") {
    return { type: "sourceFile", filePath: nodeFsPromisesShim };
  }
  if (moduleName === "node:fs" || moduleName === "fs") {
    return { type: "sourceFile", filePath: nodeFsShim };
  }
  if (moduleName === "node:path") {
    return { type: "sourceFile", filePath: nodePathShim };
  }
  if (moduleName === "node:os" || moduleName === "os") {
    return { type: "sourceFile", filePath: nodeOsShim };
  }
  if (moduleName === "node:url") {
    return { type: "sourceFile", filePath: nodeUrlShim };
  }

  const canTryNodeResolveFallback =
    typeof resolvedModuleName === "string" &&
    !resolvedModuleName.startsWith(".") &&
    !path.isAbsolute(resolvedModuleName) &&
    resolvedModuleName !== "happier";
  let lastResolutionError = null;

  if (typeof defaultResolveRequest === "function") {
    try {
      const resolved = defaultResolveRequest(context, resolvedModuleName, platform);
      if (resolved != null) return resolved;
    } catch (error) {
      lastResolutionError = error;
      if (!canTryNodeResolveFallback) throw error;
    }
  }

  if (typeof context.resolveRequest === "function") {
    try {
      const resolved = context.resolveRequest(context, resolvedModuleName, platform);
      if (resolved != null) return resolved;
    } catch (error) {
      lastResolutionError = error;
      if (!canTryNodeResolveFallback) throw error;
    }
  }

  // If Metro cannot resolve a package and we are running without crawling `node_modules` as a watch folder,
  // fall back to Node's resolution rooted at the monorepo `node_modules`. This keeps stack/runtime builds
  // working on machines without Watchman, without scanning the entire `node_modules/**` tree.
  if (canTryNodeResolveFallback) {
    try {
      const resolved = require.resolve(resolvedModuleName, { paths: [appNodeModules, rootNodeModules] });
      return { type: "sourceFile", filePath: resolved };
    } catch (error) {
      lastResolutionError = error;
    }
  }

  if (lastResolutionError) {
    throw lastResolutionError;
  }

  throw new Error(`Unable to resolve module "${resolvedModuleName}" for platform "${platform ?? "unknown"}".`);
};

module.exports = config;
