const path = require("node:path");
const fs = require("node:fs");
const {
  getSentryExpoConfig
} = require("@sentry/react-native/metro");

const generatedWorkletModulePrefixes = [
  "react-native-worklets/__generatedWorklets/",
  "react-native-worklets/.worklets/",
];
const generatedWorkletModuleIdNamespaceBase = 0x40000000;

function parseBooleanEnv(name, defaultValue) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return defaultValue;
}

const workletsBundleModeEnabled = parseBooleanEnv("HAPPIER_UI_WORKLETS_BUNDLE_MODE", false);
let workletsPackageParentDir = null;
try {
  workletsPackageParentDir = path.resolve(
    path.dirname(require.resolve("react-native-worklets/package.json")),
    "..",
  );
} catch {
  workletsPackageParentDir = null;
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

function isGeneratedWorkletImport(moduleName) {
  return typeof moduleName === "string"
    && generatedWorkletModulePrefixes.some((prefix) => moduleName.startsWith(prefix));
}

function referencesGeneratedWorkletPath(moduleName) {
  return typeof moduleName === "string"
    && generatedWorkletModulePrefixes.some((prefix) => moduleName.includes(prefix));
}

function getGeneratedWorkletPrefixIndex(moduleName) {
  if (typeof moduleName !== "string") return -1;
  const normalizedModuleName = moduleName.replaceAll("\\", "/");
  return generatedWorkletModulePrefixes.findIndex((prefix) => normalizedModuleName.includes(prefix));
}

function createGeneratedWorkletModuleId(moduleName) {
  const prefixIndex = getGeneratedWorkletPrefixIndex(moduleName);
  if (prefixIndex < 0) return null;

  const basename = path.basename(moduleName, ".js");
  const parsedNumericId = Number(basename);
  if (!Number.isSafeInteger(parsedNumericId) || parsedNumericId < 0) return null;

  return generatedWorkletModuleIdNamespaceBase
    + (parsedNumericId * generatedWorkletModulePrefixes.length)
    + prefixIndex;
}

function isReservedGeneratedWorkletModuleId(moduleId) {
  return Number.isSafeInteger(moduleId) && moduleId >= generatedWorkletModuleIdNamespaceBase;
}

function resolveGeneratedWorkletModule(moduleName) {
  if (!workletsBundleModeEnabled || !workletsPackageParentDir || !isGeneratedWorkletImport(moduleName)) return null;
  const filePath = path.join(workletsPackageParentDir, moduleName);
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
  if (!workletsBundleModeEnabled || !workletsPackageParentDir) return null;
  return generatedWorkletModulePrefixes.map((prefix) => {
    const folder = path.resolve(workletsPackageParentDir, prefix);
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      // Metro will surface the underlying filesystem problem if the folder cannot be crawled.
    }
    return folder;
  });
}

const config = getSentryExpoConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

const existingSerializer = config.serializer || {};
const existingGetModulesRunBeforeMainModule = existingSerializer.getModulesRunBeforeMainModule;
const existingCreateModuleIdFactory = existingSerializer.createModuleIdFactory;
config.serializer = {
  ...existingSerializer,
  getModulesRunBeforeMainModule(dirname) {
    const existingModules = typeof existingGetModulesRunBeforeMainModule === "function"
      ? existingGetModulesRunBeforeMainModule(dirname)
      : [];
    return [
      ...(workletsBundleModeEnabled ? getWorkletsBundleModeEntryPoints() : []),
      ...existingModules,
    ];
  },
  createModuleIdFactory() {
    const existingFactory = typeof existingCreateModuleIdFactory === "function"
      ? existingCreateModuleIdFactory()
      : null;
    let nextModuleId = 0;
    const moduleIdByName = new Map();
    const assignedModuleIds = new Set();

    function allocateNonReservedModuleId() {
      while (assignedModuleIds.has(nextModuleId) || isReservedGeneratedWorkletModuleId(nextModuleId)) {
        nextModuleId += 1;
      }
      const moduleId = nextModuleId;
      nextModuleId += 1;
      return moduleId;
    }

    return (moduleName) => {
      if (moduleIdByName.has(moduleName)) return moduleIdByName.get(moduleName);
      if (workletsBundleModeEnabled && referencesGeneratedWorkletPath(moduleName)) {
        const moduleId = createGeneratedWorkletModuleId(moduleName) ?? allocateNonReservedModuleId();
        moduleIdByName.set(moduleName, moduleId);
        assignedModuleIds.add(moduleId);
        return moduleId;
      }
      const candidateModuleId = existingFactory ? existingFactory(moduleName) : allocateNonReservedModuleId();
      const moduleId = Number.isSafeInteger(candidateModuleId)
        && !assignedModuleIds.has(candidateModuleId)
        && !isReservedGeneratedWorkletModuleId(candidateModuleId)
        ? candidateModuleId
        : allocateNonReservedModuleId();
      moduleIdByName.set(moduleName, moduleId);
      assignedModuleIds.add(moduleId);
      return moduleId;
    };
  },
};

// Cache bust knob: bump Metro's cache version without changing CLI invocation.
// Useful when the stack starts Expo without `--clear`, or when Tauri/Metro appears to serve stale bundles.
const cacheBust = String(process.env.HAPPIER_UI_METRO_CACHE_VERSION_BUST ?? '').trim();
if (cacheBust) {
  const baseVersion = String(config.cacheVersion ?? '1.0').trim() || '1.0';
  config.cacheVersion = `${baseVersion}-${cacheBust}`;
}

// Metro defaults to Watchman (and, when unavailable, falls back to the native `find` crawler). In large monorepos,
// both Watchman and the native `find` crawler can be unreliable in non-interactive "stack/runtime build" contexts:
// - Watchman can hang for ~1 minute per `watch-project` (or fail on sandboxed runners)
// - the native `find` path can exceed Node's max string length and crash
//
// In CI/e2e and stack builds, prefer Metro's Node filesystem crawler (slower but deterministic).
const isStackRun = Boolean((process.env.HAPPIER_STACK_STACK ?? '').toString().trim());
const monorepoRoot = path.resolve(__dirname, "../../");

function parseEnvBool(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return null;
}

const watchmanOverride = parseEnvBool(process.env.HAPPIER_UI_METRO_USE_WATCHMAN);
const isWatchmanDisabledForLocalRun = parseEnvBool(process.env.HAPPIER_UI_METRO_DISABLE_WATCHMAN) === true;

// Keep Watchman opt-in. This app has historically hit Watchman startup / recrawl issues in the monorepo, so local
// development defaults to Metro's Node crawler unless a machine explicitly opts in.
const isCiRun = Boolean(process.env.CI);
const shouldUseWatchman = !isCiRun && !isStackRun && !isWatchmanDisabledForLocalRun && watchmanOverride === true;
config.resolver.useWatchman = shouldUseWatchman;
if (isWatchmanDisabledForLocalRun) {
  config.watcher = {
    ...(config.watcher || {}),
    useWatchman: false,
  };
}
if (config.watcher && Object.prototype.hasOwnProperty.call(config.watcher, 'unstable_workerThreads')) {
  delete config.watcher.unstable_workerThreads;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveInternalWorkspaceWatchFolders() {
  const uiPkgPath = path.resolve(__dirname, "package.json");
  const uiPkg = safeReadJson(uiPkgPath);
  if (!uiPkg) return [];

  const depSources = [uiPkg.dependencies, uiPkg.optionalDependencies, uiPkg.devDependencies];
  const internal = new Set();
  for (const src of depSources) {
    if (!src || typeof src !== "object") continue;
    for (const name of Object.keys(src)) {
      if (!String(name).startsWith("@happier-dev/")) continue;
      internal.add(String(name));
    }
  }

  return [...internal]
    .map((name) => String(name).split("/")[1] || "")
    .filter((id) => id.length > 0)
    .map((id) => path.resolve(monorepoRoot, "packages", id))
    .filter((pkgDir) => fs.existsSync(pkgDir));
}

const internalWorkspaceWatchFolders = resolveInternalWorkspaceWatchFolders();

function addInternalWorkspaceWatchFolders() {
  if (!(process.env.CI || isStackRun)) return;

  if (!Array.isArray(config.watchFolders)) {
    config.watchFolders = [];
  }

  for (const pkgDir of internalWorkspaceWatchFolders) {
    if (!config.watchFolders.includes(pkgDir)) {
      config.watchFolders.push(pkgDir);
    }
  }
}

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

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
const hstackWebArtifactExportBlockList = /[\\/]\.expo[\\/]hstack[\\/]web-artifact-export[\\/]/;
// Avoid scanning duplicate workspace-local `node_modules/**` trees (typically symlink-heavy) when Metro falls back
// to the native `find` crawler (no Watchman). We still keep the monorepo root `node_modules` and `apps/ui/node_modules`.
const workspaceNodeModulesBlockList =
  /[\\/]apps[\\/](?!ui[\\/])[^\\/]+[\\/]node_modules[\\/]|[\\/]packages[\\/][^\\/]+[\\/]node_modules[\\/]/;
// Also skip nested dependency-private `node_modules/**` trees under watched app/root `node_modules/**`.
// Metro resolves dependencies through the top-level search paths; crawling nested package-local copies adds a lot of
// redundant work and frequently hits transient ENOENTs in hoisted/symlinked dependency layouts.
const nestedDependencyNodeModulesBlockList =
  /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+[\\/]node_modules[\\/]/;
const existingBlockList = config.resolver.blockList;
  config.resolver.blockList = Array.isArray(existingBlockList)
  ? [...existingBlockList, testRouteBlockList, projectArtifactsBlockList, nextBuildArtifactsBlockList, hstackWebArtifactExportBlockList, workspaceNodeModulesBlockList, nestedDependencyNodeModulesBlockList]
  : existingBlockList
    ? [existingBlockList, testRouteBlockList, projectArtifactsBlockList, nextBuildArtifactsBlockList, hstackWebArtifactExportBlockList, workspaceNodeModulesBlockList, nestedDependencyNodeModulesBlockList]
    : [testRouteBlockList, projectArtifactsBlockList, nextBuildArtifactsBlockList, hstackWebArtifactExportBlockList, workspaceNodeModulesBlockList, nestedDependencyNodeModulesBlockList];

addInternalWorkspaceWatchFolders();

const existingWatchFolders = Array.isArray(config.watchFolders) ? config.watchFolders : [];
config.watchFolders = existingWatchFolders.filter(
  (folder, index, all) => typeof folder === 'string' && folder.length > 0 && all.indexOf(folder) === index,
);

const rootNodeModules = path.resolve(__dirname, "../../node_modules");
const appNodeModules = path.resolve(__dirname, "node_modules");
const generatedWorkletsWatchFolders = resolveGeneratedWorkletsWatchFolders() || [];
for (const generatedWorkletsWatchFolder of generatedWorkletsWatchFolders) {
  if (!config.watchFolders.includes(generatedWorkletsWatchFolder)) {
    config.watchFolders.push(generatedWorkletsWatchFolder);
  }
}

// Metro requires that all resolved module files live under either `projectRoot` or `watchFolders` so it can compute
// SHA-1 hashes for caching. In Yarn workspaces, many deps are hoisted to the monorepo root `node_modules/**`.
//
// Default: include the monorepo root `node_modules/**` so hoisted dependencies (e.g. `fbjs`) never fail with
// "Failed to get the SHA-1".
//
// If Watchman is unstable on a machine, the recommended path is to disable Watchman
// (`HAPPIER_UI_METRO_USE_WATCHMAN=0`) rather than excluding hoisted deps from watch roots.
const watchRootNodeModulesSetting = parseEnvBool(process.env.HAPPIER_UI_METRO_WATCH_MONOREPO_ROOT_NODE_MODULES);
if (watchRootNodeModulesSetting === false) {
  config.watchFolders = config.watchFolders.filter((folder) => folder !== rootNodeModules);
}

function resolveHoistedExpoPackageWatchFolders(nodeModulesRoot) {
  const root = String(nodeModulesRoot ?? '').trim();
  if (!root) return [];
  if (String(process.env.HAPPIER_UI_METRO_WATCH_HOISTED_EXPO_PACKAGES ?? '1').trim() === '0') return [];

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry?.isDirectory?.())
      .map((entry) => String(entry.name ?? '').trim())
      .filter((name) => name === 'expo' || name.startsWith('expo-'))
      .map((name) => path.resolve(root, name));
  } catch {
    return [];
  }
}

// Expo packages can be hoisted into the monorepo root `node_modules/**` and ship TypeScript entrypoints.
// Metro needs these files in its watch set to compute SHA-1 hashes during export/build, but we still want
// to avoid watching the entire monorepo `node_modules/**` tree.
const shouldWatchHoistedNodeModuleChildren = !config.watchFolders.includes(rootNodeModules);
const watchedHoistedNodeModuleRoots = shouldWatchHoistedNodeModuleChildren
  ? [
      path.resolve(rootNodeModules, "expo-modules-core"),
      path.resolve(rootNodeModules, "expo-system-ui"),
      ...resolveHoistedExpoPackageWatchFolders(rootNodeModules),
    ].filter((folder) => fs.existsSync(folder))
  : [];
for (const folder of watchedHoistedNodeModuleRoots) {
  if (!config.watchFolders.includes(folder)) {
    config.watchFolders.push(folder);
  }
}

const shouldNarrowWatchFolders = parseEnvBool(process.env.HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS) === true;
const shouldRestoreMinimalNodeModulesPaths =
  shouldNarrowWatchFolders && parseEnvBool(process.env.EXPO_NO_METRO_WORKSPACE_ROOT) === true;
if (shouldRestoreMinimalNodeModulesPaths) {
  const existingNodeModulesPaths = Array.isArray(config.resolver.nodeModulesPaths)
    ? config.resolver.nodeModulesPaths
    : [];
  // In narrowed CI/stack web runs, keep React and other peer singletons pinned to the app/root
  // node_modules search paths. Otherwise Metro can walk into nested package-local node_modules
  // (for example `@react-navigation/native/node_modules/react`) and produce invalid-hook-call
  // failures from duplicate React copies in the web bundle.
  config.resolver.disableHierarchicalLookup = true;
  config.resolver.nodeModulesPaths = [
    appNodeModules,
    rootNodeModules,
    ...existingNodeModulesPaths,
  ].filter((folder, index, all) => fs.existsSync(folder) && all.indexOf(folder) === index);
}
if (shouldNarrowWatchFolders) {
  const allowedWatchFolders = new Set([
    ...(shouldRestoreMinimalNodeModulesPaths && fs.existsSync(rootNodeModules) ? [rootNodeModules] : []),
    ...internalWorkspaceWatchFolders,
    ...watchedHoistedNodeModuleRoots,
    ...generatedWorkletsWatchFolders,
  ]);
  config.watchFolders = config.watchFolders.filter((folder) => allowedWatchFolders.has(folder));
  if (shouldRestoreMinimalNodeModulesPaths && fs.existsSync(rootNodeModules) && !config.watchFolders.includes(rootNodeModules)) {
    config.watchFolders.unshift(rootNodeModules);
  }
}

// Keep Expo's default workspace watch roots even when Watchman is disabled so the config stays aligned with Expo's
// dependency graph expectations. Large artifact trees are excluded via Metro block lists above instead of removing
// whole workspaces from the watch set.

const nodePathShim = path.resolve(__dirname, "sources/platform/nodeShims/nodePathShim.ts");
const nodeFsPromisesShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeFsPromisesShim.ts");
const nodeFsShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeFsShim.ts");
const nodeUrlShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeUrlShim.ts");
const nodeCryptoShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeCryptoShim.ts");
const transformersStub = path.resolve(__dirname, "sources/platform/stubs/huggingfaceTransformersStub.ts");
const fontFaceObserverWebShim = path.resolve(__dirname, "sources/platform/shims/fontFaceObserverWebShim.ts");
const reactNativeWebShim = path.resolve(__dirname, "sources/platform/shims/reactNativeWebShim.ts");
const expoSystemUiWebStub = path.resolve(__dirname, "sources/platform/stubs/expoSystemUiWebStub.ts");
const reactNativeDevToolsSettingsManagerWebStub = path.resolve(__dirname, "sources/platform/stubs/reactNativeDevToolsSettingsManagerWebStub.ts");
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

function isFileBlockedByMetro(blockList, filePath) {
  if (!blockList || !filePath) return false;
  if (blockList instanceof RegExp) return blockList.test(filePath);
  if (Array.isArray(blockList)) return blockList.some((item) => item instanceof RegExp && item.test(filePath));
  return false;
}

function resolveExplicitRelativeImportFromOrigin({ originModulePath, moduleName, blockList }) {
  if (typeof originModulePath !== 'string' || originModulePath.length === 0) return null;
  if (typeof moduleName !== 'string' || moduleName.length === 0) return null;
  if (!moduleName.startsWith('.')) return null;

  const ext = path.extname(moduleName);
  if (!ext) return null;

  // Respect packages that explicitly import `*.node.js` files but ship a browser mapping
  // (via package.json "browser") that rewrites them to the non-node variant. Our CI/stack
  // fast-path resolver runs before Metro applies those mappings, so emulate the common
  // `*.node.js` -> `*.js` rewrite when the browser file exists.
  let normalizedModuleName = moduleName;
  if (normalizedModuleName.endsWith('.node.js')) {
    const browserVariant = normalizedModuleName.replace(/\.node\.js$/u, '.js');
    const browserCandidate = path.resolve(path.dirname(originModulePath), browserVariant);
    if (!isFileBlockedByMetro(blockList, browserCandidate) && fs.existsSync(browserCandidate)) {
      normalizedModuleName = browserVariant;
    }
  }

  const candidate = path.resolve(path.dirname(originModulePath), normalizedModuleName);
  if (isFileBlockedByMetro(blockList, candidate)) return null;
  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

function resolvePackageExportTarget(entry) {
  if (typeof entry === "string" && entry.length > 0) return entry;
  if (!entry || typeof entry !== "object") return null;
  const candidate =
    entry.default ??
    entry.import ??
    entry.require ??
    null;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function resolveInternalWorkspacePackageViaRootNodeModules(moduleName, blockList) {
  if (!(shouldRestoreMinimalNodeModulesPaths || isStackRun)) return null;
  if (typeof moduleName !== "string" || !moduleName.startsWith("@happier-dev/")) return null;

  const parts = moduleName.split("/");
  if (parts.length < 2) return null;
  const packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : moduleName;
  const subpath = parts.length > 2 ? parts.slice(2).join("/") : "";
  const packageRoot = path.resolve(rootNodeModules, packageName);
  const packageJsonPath = path.resolve(packageRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;

  const packageJson = safeReadJson(packageJsonPath);
  if (!packageJson || typeof packageJson !== "object") return null;
  const exportKey = subpath.length > 0 ? `./${subpath}` : ".";
  const exportTarget = resolvePackageExportTarget(
    packageJson.exports?.[exportKey] ??
    (subpath.length === 0 ? packageJson.main : null),
  );
  if (!exportTarget) return null;

  const candidate = path.resolve(packageRoot, exportTarget);
  if (isFileBlockedByMetro(blockList, candidate)) return null;
  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const generatedWorkletResolution = resolveGeneratedWorkletModule(moduleName);
  if (generatedWorkletResolution) return generatedWorkletResolution;

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

  if (process.env.CI || isStackRun) {
    const explicit = resolveExplicitRelativeImportFromOrigin({
      originModulePath: context?.originModulePath,
      moduleName: resolvedModuleName,
      blockList: config.resolver.blockList,
    });
    if (explicit) {
      return { type: "sourceFile", filePath: explicit };
    }
  }

  const internalWorkspacePackagePath = resolveInternalWorkspacePackageViaRootNodeModules(
    resolvedModuleName,
    config.resolver.blockList,
  );
  if (internalWorkspacePackagePath) {
    return { type: "sourceFile", filePath: internalWorkspacePackagePath };
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

  // Browser Kokoro/ORT runtime support has been removed from the active web bundle.
  // Fail closed at the resolver boundary so transitive dependencies cannot pull the
  // old browser runtime back into export/build flows.
  if (
    platform === "web" &&
    (
      resolvedModuleName === "kokoro-js" ||
      resolvedModuleName.startsWith("kokoro-js/") ||
      resolvedModuleName === "onnxruntime-web" ||
      resolvedModuleName.startsWith("onnxruntime-web/")
    )
  ) {
    return { type: "empty" };
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

  if (
    platform === "web" &&
    resolvedModuleName === "../../src/private/devsupport/rndevtools/ReactDevToolsSettingsManager" &&
    /[\\/]node_modules[\\/]react-native[\\/]Libraries[\\/]Core[\\/]setUpReactDevTools\.js$/u.test(String(context?.originModulePath ?? ""))
  ) {
    return { type: "sourceFile", filePath: reactNativeDevToolsSettingsManagerWebStub };
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
  if (moduleName === "node:url") {
    return { type: "sourceFile", filePath: nodeUrlShim };
  }
  if (moduleName === "node:crypto") {
    // `node:crypto` is imported by vitest-only `*.node.ts` platform variants
    // (e.g. cryptoRandom.node.ts). Metro scans those files during haste-map
    // build even though they're never imported from RN code, so the resolver
    // has to map the bare `node:crypto` specifier to an empty stub. The RN
    // runtime never reaches this — it uses expo-crypto via the sibling .ts.
    return { type: "sourceFile", filePath: nodeCryptoShim };
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
