#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function resolveSpawnHelperPaths(cwd) {
  const root = path.resolve(String(cwd ?? process.cwd()).trim() || process.cwd());
  return [
    path.join(root, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
    path.join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release', 'spawn-helper'),
  ];
}

function fixNodePtySpawnHelperPermissions(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const existsSync = options.existsSync ?? fs.existsSync;
  const chmodSync = options.chmodSync ?? fs.chmodSync;
  const paths = resolveSpawnHelperPaths(cwd);

  let fixed = 0;
  for (const helperPath of paths) {
    if (!existsSync(helperPath)) continue;
    try {
      chmodSync(helperPath, 0o755);
      fixed += 1;
    } catch {
      // Best-effort: leave the install working even if a single path is read-only.
    }
  }

  return {
    fixed,
    paths,
  };
}

module.exports = {
  fixNodePtySpawnHelperPermissions,
  resolveSpawnHelperPaths,
};

if (require.main === module) {
  try {
    fixNodePtySpawnHelperPermissions();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
