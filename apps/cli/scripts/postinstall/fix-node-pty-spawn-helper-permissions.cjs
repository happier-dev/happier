'use strict';

const fs = require('node:fs');
const path = require('node:path');

function hasAnyExecuteBit(mode) {
    return (mode & 0o111) !== 0;
}

async function maybeChmodExecutable(filePath) {
    const st = await fs.promises.stat(filePath);
    const mode = st.mode & 0o777;
    if (hasAnyExecuteBit(mode)) {
        return false;
    }
    await fs.promises.chmod(filePath, 0o755);
    return true;
}

async function listSpawnHelperCandidates(nodePtyDir) {
    const out = [];

    const prebuildsDir = path.resolve(nodePtyDir, 'prebuilds');
    try {
        const entries = await fs.promises.readdir(prebuildsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            out.push(path.resolve(prebuildsDir, entry.name, 'spawn-helper'));
        }
    } catch {
        // ignore
    }

    out.push(path.resolve(nodePtyDir, 'build', 'Release', 'spawn-helper'));

    return out;
}

async function fixNodePtySpawnHelperPermissions(input) {
    const platform = typeof input?.platform === 'string' ? input.platform : process.platform;
    if (platform === 'win32') {
        return { changed: 0 };
    }

    const nodePtyDirs = Array.isArray(input?.nodePtyDirs) ? input.nodePtyDirs.filter(Boolean) : [];
    if (nodePtyDirs.length === 0) {
        return { changed: 0 };
    }

    let changed = 0;
    for (const nodePtyDir of nodePtyDirs) {
        const candidates = await listSpawnHelperCandidates(nodePtyDir);
        for (const candidate of candidates) {
            try {
                const did = await maybeChmodExecutable(candidate);
                if (did) changed += 1;
            } catch {
                // Ignore missing files and chmod failures best-effort; terminal is optional.
            }
        }
    }

    return { changed };
}

module.exports = {
    fixNodePtySpawnHelperPermissions,
};

if (require.main === module) {
    (async () => {
        const packageRoot = path.resolve(__dirname, '..', '..');
        const repoRoot = path.resolve(packageRoot, '..', '..');

        const candidates = [
            path.resolve(packageRoot, 'node_modules', 'node-pty'),
            path.resolve(repoRoot, 'node_modules', 'node-pty'),
        ];

        const nodePtyDirs = Array.from(new Set(candidates));

        await fixNodePtySpawnHelperPermissions({ nodePtyDirs });
    })().catch(() => {
        // Best-effort; terminal has fallbacks.
    });
}
