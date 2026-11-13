const path = require("node:path");
const { builtinModules } = require("node:module");

const nodeBuiltinSpecifiers = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
);

function isWithin(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Web (Expo's Node-externals resolver) and native (this app's empty-builtin shims)
// resolve a Node builtin to an empty module so third-party packages with dormant Node
// branches still bundle. First-party source has no such excuse: an empty `node:stream`
// evaluates as `undefined` only when the importing code runs ("Class extends value
// undefined" on Send). Fail the graph at the import site instead, for every platform.
function createNodeBuiltinBoundary({ repoRoot, stubDirectory }) {
  const isStub = (resolution) => resolution?.type === "empty"
    || (resolution?.type === "sourceFile" && isWithin(stubDirectory, resolution.filePath));
  return function refuseStubbedFirstPartyNodeBuiltin(context, moduleName, platform, resolution) {
    if (!nodeBuiltinSpecifiers.has(moduleName) || !isStub(resolution)) return resolution;
    const origin = String(context?.originModulePath ?? "");
    if (!isWithin(repoRoot, origin) || /[\\/]node_modules[\\/]/u.test(origin)) return resolution;
    throw Object.assign(
      new Error(
        `First-party module ${path.relative(repoRoot, origin)} imports Node builtin "${moduleName}" into the ${platform ?? "unknown"} UI graph, `
          + "where it resolves to an empty stub. Move the Node-only code behind a Node-only module or package subpath "
          + "that this graph does not import.",
      ),
      { type: "NotFoundError", filename: origin },
    );
  };
}

module.exports = { createNodeBuiltinBoundary };
