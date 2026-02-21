import fs from 'node:fs';
import path from 'node:path';

/**
 * Yarn workspace `nohoist` keeps React/React Native dependencies under the Expo app workspace.
 * Some tooling executed from hoisted packages (e.g. expo-dev-launcher during EAS local builds)
 * expects to resolve these peer deps from the repo root `node_modules`.
 *
 * We bridge that gap by creating root-level symlinks to the nohoisted workspace installs.
 *
 * @param {{ repoRootDir: string; expoAppDir: string }} opts
 */
export function ensureNohoistPeerLinks(opts) {
    const repoRootDir = path.resolve(opts.repoRootDir);
    const expoAppDir = path.resolve(opts.expoAppDir);

    const repoRootNodeModulesDir = path.join(repoRootDir, 'node_modules');
    const expoAppNodeModulesDir = path.join(expoAppDir, 'node_modules');

    if (!fs.existsSync(repoRootNodeModulesDir) || !fs.existsSync(expoAppNodeModulesDir)) return;

    const packages = ['react', 'react-dom', 'react-native'];
    for (const pkg of packages) {
        const target = path.join(expoAppNodeModulesDir, pkg);
        const link = path.join(repoRootNodeModulesDir, pkg);

        if (fs.existsSync(link)) continue;
        if (!fs.existsSync(target)) continue;

        try {
            fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(`Unable to create root nohoist peer link for '${pkg}': ${message}`);
        }
    }
}

