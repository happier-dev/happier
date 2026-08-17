import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runCommandBestEffort } from './runCommand.mjs';
import { verifyReactNativeEnrichedMarkdownPatch } from './verifyReactNativeEnrichedMarkdownPatch.mjs';

const PATCH_FILE_NAME = 'react-native-enriched-markdown+0.5.0.patch';

export function repairReactNativeEnrichedMarkdownPatch({
    packageDir,
    patchDir,
    patchPackageCliPath,
    label = 'installed',
}) {
    if (verifyReactNativeEnrichedMarkdownPatch({ packageDir })) return true;

    const nodeModulesDir = path.dirname(packageDir);
    if (path.basename(nodeModulesDir) !== 'node_modules') return false;

    const appRootDir = path.dirname(nodeModulesDir);
    const patchFilePath = path.resolve(patchDir, PATCH_FILE_NAME);
    if (!fs.existsSync(patchFilePath) || !fs.existsSync(patchPackageCliPath)) return false;

    const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, '-') || 'installed';
    const recoveryWorkingDir = fs.mkdtempSync(
        path.join(appRootDir, `.happier-enriched-markdown-repair-${safeLabel}-`),
    );
    const recoveryPatchDir = path.join(recoveryWorkingDir, 'patches');
    const recoveryNodeModulesLink = path.join(recoveryWorkingDir, 'node_modules');
    try {
        fs.mkdirSync(recoveryPatchDir);
        fs.writeFileSync(
            path.join(recoveryWorkingDir, 'package.json'),
            '{"name":"happier-enriched-markdown-repair","private":true}\n',
        );
        fs.symlinkSync(
            nodeModulesDir,
            recoveryNodeModulesLink,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        fs.copyFileSync(patchFilePath, path.join(recoveryPatchDir, PATCH_FILE_NAME));
        runCommandBestEffort({
            command: process.execPath,
            args: [
                patchPackageCliPath,
                '--patch-dir',
                'patches',
                '--partial',
            ],
            options: { cwd: recoveryWorkingDir },
        });
    } finally {
        fs.rmSync(recoveryNodeModulesLink, { force: true });
        fs.rmSync(recoveryWorkingDir, { recursive: true, force: true });
    }

    return verifyReactNativeEnrichedMarkdownPatch({ packageDir });
}
