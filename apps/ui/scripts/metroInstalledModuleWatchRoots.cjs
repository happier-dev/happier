const fs = require('node:fs');
const path = require('node:path');

exports.resolveInstalledModuleWatchRoots = function resolveInstalledModuleWatchRoots(moduleRoots) {
  const installedModuleWatchRoots = new Set();
  for (const modulesDir of new Set(moduleRoots)) {
    if (!fs.existsSync(modulesDir)) continue;
    const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '@happier-dev') continue;
      const entryPath = path.join(modulesDir, entry.name);
      const candidates = entry.name.startsWith('@')
        ? fs.readdirSync(entryPath).map(name => path.join(entryPath, name)) : [entryPath];
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const target = fs.realpathSync(candidate);
        if (target === candidate) continue; // An ordinary installed directory is already subject to the configured watch policy.
        if (!fs.statSync(target).isDirectory()) continue;
        // Stop at the package's installed tree, before a retained-generation store.
        let installedRoot = null;
        for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) {
          if (path.basename(parent) === 'node_modules') {
            installedRoot = parent;
            break;
          }
        }
        // Links to authored workspaces are source roots, not installed modules.
        // Their existing source-resolution/watch owner decides which are live.
        if (installedRoot) installedModuleWatchRoots.add(installedRoot);
      }
    }
  }
  return installedModuleWatchRoots;
};
