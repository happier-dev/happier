const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

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
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = Array.isArray(existingBlockList)
  ? [...existingBlockList, testRouteBlockList]
  : existingBlockList
    ? [existingBlockList, testRouteBlockList]
    : [testRouteBlockList];

// Kokoro (kokoro-js) ships a `.web.js` prebundle that Metro cannot transform (it contains non-literal dynamic imports).
// For Expo web, force Metro to resolve the package to its ESM entry and shim Node builtins that the ESM file imports
// but never uses in browser mode.
const kokoroEntryPoint = path.resolve(__dirname, "../../node_modules/kokoro-js/dist/kokoro.js");
const nodePathShim = path.resolve(__dirname, "sources/platform/nodeShims/nodePathShim.ts");
const nodeFsPromisesShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeFsPromisesShim.ts");
const nodeFsShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeFsShim.ts");
const nodeUrlShim = path.resolve(__dirname, "sources/platform/nodeShims/nodeUrlShim.ts");
const onnxruntimeWebStub = path.resolve(__dirname, "sources/platform/stubs/onnxruntimeWebStub.ts");
const kokoroJsStub = path.resolve(__dirname, "sources/platform/stubs/kokoroJsStub.ts");
const transformersStub = path.resolve(__dirname, "sources/platform/stubs/huggingfaceTransformersStub.ts");
const fontFaceObserverWebShim = path.resolve(__dirname, "sources/platform/shims/fontFaceObserverWebShim.ts");

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Fix event-target-shim/index import - exports define "." not "./index"
  let resolvedModuleName = moduleName;
  if (moduleName === "event-target-shim/index") {
    resolvedModuleName = "event-target-shim";
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
  if (moduleName === "fs/promises") {
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

  if (typeof defaultResolveRequest === "function") {
    return defaultResolveRequest(context, moduleName, platform);
  }
  if (typeof context.resolveRequest === "function") {
    return context.resolveRequest(context, moduleName, platform);
  }
  return null;
};

module.exports = config;
