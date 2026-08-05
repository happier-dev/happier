import fs from 'node:fs';
import path from 'node:path';

function listPatchFiles(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

function resolvePatchTargetPackageName(patchFileName) {
    const raw = patchFileName.endsWith('.patch') ? patchFileName.slice(0, -'.patch'.length) : patchFileName;
    const parts = raw.split('+').filter(Boolean);
    if (parts.length < 2) return '';
    if (parts[0].startsWith('@')) {
        if (parts.length < 3) return '';
        return `${parts[0]}/${parts[1]}`;
    }
    return parts[0];
}

function packageExists(nodeModulesDir, packageName) {
    if (!nodeModulesDir || !packageName) return false;
    return fs.existsSync(path.resolve(nodeModulesDir, packageName));
}

export function createFilteredPatchDir({ patchDir, nodeModulesDir, label }) {
    const patchFiles = listPatchFiles(patchDir);
    if (patchFiles.length === 0) return '';

    const selected = patchFiles.filter((fileName) => {
        const packageName = resolvePatchTargetPackageName(fileName);
        return packageExists(nodeModulesDir, packageName);
    });
    if (selected.length === 0) return '';

    // GitHub's Windows checkout is commonly on D: while os.tmpdir() is on C:. patch-package
    // cannot consume that cross-volume --patch-dir reliably, so keep the filtered directory
    // inside the target node_modules volume and remove it immediately after patching.
    const safeLabel = String(label ?? 'target').replace(/[^a-z0-9_-]+/gi, '-') || 'target';
    const temporaryDir = fs.mkdtempSync(path.join(nodeModulesDir, `.happier-ui-patches-${safeLabel}-`));
    for (const fileName of selected) {
        fs.copyFileSync(path.resolve(patchDir, fileName), path.resolve(temporaryDir, fileName));
    }
    return temporaryDir;
}
