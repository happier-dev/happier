const fs = require('node:fs');
const path = require('node:path');

function findInstalledRoot(packagePath) {
  for (let parent = path.dirname(packagePath); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    if (path.basename(parent) === 'node_modules') return parent;
  }
  return null;
}

function addLinkedWatchRoots(candidate, roots) {
  if (!fs.existsSync(candidate)) return;
  const target = fs.realpathSync(candidate);
  if (target === candidate || !fs.statSync(target).isDirectory()) return;
  const installedRoot = findInstalledRoot(target);
  // Authored workspace targets belong to the workspace source watch policy.
  if (!installedRoot) return;
  roots.add(installedRoot);

  // A finite export mounts dependencies from the revision tree, whose entries
  // are themselves links to the pinned installation. Metro walks those links
  // through its file map, so it needs their intermediate roots as well.
  for (let link = candidate; link !== target && fs.lstatSync(link).isSymbolicLink();) {
    const destination = fs.readlinkSync(link);
    // An installed package's relative link is based in its physical scope,
    // which may itself be mounted through a directory symlink.
    link = path.isAbsolute(destination) ? destination
      : path.resolve(fs.realpathSync(path.dirname(link)), destination);
    const root = findInstalledRoot(link);
    if (root) roots.add(root);
  }
}

exports.resolveInstalledModuleWatchRoots = function resolveInstalledModuleWatchRoots(moduleRoots) {
  const installedModuleWatchRoots = new Set();
  for (const modulesDir of new Set(moduleRoots)) {
    if (!fs.existsSync(modulesDir)) continue;
    const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '@happier-dev') continue;
      const entryPath = path.join(modulesDir, entry.name);
      addLinkedWatchRoots(entryPath, installedModuleWatchRoots);
      if (entry.name.startsWith('@') && fs.existsSync(entryPath)) {
        for (const name of fs.readdirSync(entryPath)) {
          addLinkedWatchRoots(path.join(entryPath, name), installedModuleWatchRoots);
        }
      }
    }
  }
  return installedModuleWatchRoots;
};
