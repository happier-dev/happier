import { join, resolve } from 'node:path';

import { createTempDirSync, removeTempDirSync } from '../../../src/testkit/fs/tempDir';
import { ensureDirectorySync } from '../../../src/testkit/fs/fileHelpers';
import { writeSandboxJsonFile, writeSandboxPackage, writeSandboxTextFile } from './cliBinPreflightSandbox';

function resolvePackageDir(baseDir: string, packageName: string): string {
    return resolve(baseDir, ...packageName.split('/'));
}

export function createPackageLayoutSandbox(prefix: string): {
    repoRoot: string;
    happyCliDir: string;
    cleanup: () => void;
} {
    const repoRoot = createTempDirSync(prefix);
    const happyCliDir = resolve(repoRoot, 'apps', 'cli');

    ensureDirectorySync(happyCliDir);
    writeSandboxJsonFile(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeSandboxTextFile(resolve(repoRoot, 'yarn.lock'), '# lock\n');

    return {
        repoRoot,
        happyCliDir,
        cleanup() {
            removeTempDirSync(repoRoot);
        },
    };
}

export function writeCliBundledHostPackage(options: {
    happyCliDir: string;
    bundledDependencies?: readonly string[];
    dependencies?: Readonly<Record<string, string>>;
}): void {
    writeSandboxJsonFile(join(options.happyCliDir, 'package.json'), {
        name: '@happier-dev/cli',
        ...(options.bundledDependencies ? { bundledDependencies: [...options.bundledDependencies] } : {}),
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    });
}

export function writeWorkspacePackageFixture(options: {
    repoRoot: string;
    workspacePath: string;
    packageName: string;
    manifestOverrides?: Readonly<Record<string, unknown>>;
    files?: Readonly<Record<string, string>>;
}): string {
    const packageDir = resolve(options.repoRoot, options.workspacePath);

    writeSandboxPackage({
        packageDir,
        manifest: {
            name: options.packageName,
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            types: './dist/index.d.ts',
            exports: {
                '.': {
                    default: './dist/index.js',
                    types: './dist/index.d.ts',
                },
            },
            ...(options.manifestOverrides ?? {}),
        },
        files: {
            'dist/index.js': 'export {};\n',
            ...(options.files ?? {}),
        },
    });

    return packageDir;
}

export function writeRuntimeDependencyStub(options: {
    repoRoot: string;
    packageName: string;
    manifestOverrides?: Readonly<Record<string, unknown>>;
    files?: Readonly<Record<string, string>>;
}): string {
    const packageDir = resolvePackageDir(resolve(options.repoRoot, 'node_modules'), options.packageName);

    writeSandboxPackage({
        packageDir,
        manifest: {
            name: options.packageName,
            version: '1.0.0',
            main: 'index.js',
            ...(options.manifestOverrides ?? {}),
        },
        files: {
            'index.js': 'module.exports = {};\n',
            ...(options.files ?? {}),
        },
    });

    return packageDir;
}
