import { existsSync, readFileSync } from 'node:fs';
import { normalize, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readBundledPluginWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';
import * as workspacePackageResolution from './vitestWorkspacePackageResolution';

const {
    workspacePackageOptimizationExcludes,
    workspacePackageSourcesPlugin,
} = workspacePackageResolution;

type PackageExports = Readonly<Record<string, unknown>>;

function readPackageExports(packageRoot: string): PackageExports {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as Readonly<{
        exports: PackageExports;
    }>;
    return packageJson.exports;
}

function readCliFirstPartyNonPluginDependencies(): readonly string[] {
    const cliPackageJson = JSON.parse(readFileSync(resolve('./package.json'), 'utf8')) as Readonly<{
        dependencies?: Readonly<Record<string, unknown>>;
    }>;
    return Object.keys(cliPackageJson.dependencies ?? {})
        .filter((packageName) => (
            packageName.startsWith('@happier-dev/')
            && !packageName.startsWith('@happier-dev/plugins-')
        ))
        .sort();
}

function readDefaultExportTarget(target: unknown): string | null {
    if (typeof target === 'string') return target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return null;

    const conditionalTarget = target as Readonly<Record<string, unknown>>;
    return typeof conditionalTarget.default === 'string'
        ? conditionalTarget.default
        : typeof conditionalTarget.import === 'string'
            ? conditionalTarget.import
            : null;
}

function readPluginSdkPublicEntrypoints(): readonly Readonly<{
    packageSpecifier: string;
    sourcePath: string;
}>[] {
    const packageRoot = resolve('../../packages/plugin-sdk');
    const sourceRoot = resolve(packageRoot, 'src');
    return Object.entries(readPackageExports(packageRoot)).flatMap(([packageExport, target]) => {
        const outputTarget = readDefaultExportTarget(target);
        const sourceSubpath = outputTarget === './dist/index.js'
            ? ''
            : outputTarget?.startsWith('./dist/') && outputTarget.endsWith('/index.js')
                ? outputTarget.slice('./dist/'.length, -'/index.js'.length)
                : null;
        if (sourceSubpath === null) return [];

        return [{
            packageSpecifier: packageExport === '.'
                ? '@happier-dev/plugin-sdk'
                : `@happier-dev/plugin-sdk/${packageExport.slice('./'.length)}`,
            sourcePath: resolve(sourceRoot, sourceSubpath, 'index.public.ts'),
        }];
    });
}

describe('CLI Vitest workspace package source resolution', () => {
    it('uses the shared export-driven resolver instead of package-specific aliases', () => {
        expect(workspacePackageResolution).not.toHaveProperty('workspacePackageAliases');
        expect(workspacePackageSourcesPlugin.name).toBe('happier-cli-workspace-package-sources');
    });

    it('resolves every declared public Plugin SDK index entrypoint to its authored public leaf', () => {
        const entrypoints = readPluginSdkPublicEntrypoints();
        expect(entrypoints.length).toBeGreaterThan(0);

        for (const { packageSpecifier, sourcePath } of entrypoints) {
            expect(existsSync(sourcePath), packageSpecifier).toBe(true);
            expect(
                normalize(workspacePackageSourcesPlugin.resolveId(packageSpecifier) ?? ''),
                packageSpecifier,
            ).toBe(normalize(sourcePath));
        }
    });

    it('follows the Channels public V1 connection import through the SDK public export', () => {
        const channelsV1 = workspacePackageSourcesPlugin.resolveId(
            '@happier-dev/channels-protocol/v1',
        );
        const providerIndex = workspacePackageSourcesPlugin.resolveId(
            './provider/index.js',
            channelsV1 ?? undefined,
        );
        const connection = workspacePackageSourcesPlugin.resolveId(
            './connection.js',
            providerIndex ?? undefined,
        );

        expect(normalize(channelsV1 ?? '')).toBe(normalize(resolve(
            '../../packages/channels-protocol/src/v1/index.ts',
        )));
        expect(normalize(providerIndex ?? '')).toBe(normalize(resolve(
            '../../packages/channels-protocol/src/v1/provider/index.ts',
        )));
        expect(normalize(connection ?? '')).toBe(normalize(resolve(
            '../../packages/channels-protocol/src/v1/provider/connection.ts',
        )));
        expect(
            normalize(workspacePackageSourcesPlugin.resolveId(
                '@happier-dev/plugin-sdk/connected-accounts',
                connection ?? undefined,
            ) ?? ''),
        ).toBe(normalize(resolve(
            '../../packages/plugin-sdk/src/connected-accounts/index.public.ts',
        )));
    });

    it('resolves declared renamed and authored-file exports without source-path fallback', () => {
        expect(
            normalize(workspacePackageSourcesPlugin.resolveId(
                '@happier-dev/protocol/automations/event',
            ) ?? ''),
        ).toBe(normalize(resolve(
            '../../packages/protocol/src/automations/automationEventV1.ts',
        )));
        expect(
            normalize(workspacePackageSourcesPlugin.resolveId(
                '@happier-dev/cli-common/cliDistBuildManifest',
            ) ?? ''),
        ).toBe(normalize(resolve(
            '../../packages/cli-common/cliDistBuildManifest.cjs',
        )));
        expect(workspacePackageSourcesPlugin.resolveId(
            '@happier-dev/protocol/automations/automationEventV1',
        )).toBeNull();
    });

    it('derives every bundled plugin source package from canonical shippable membership', () => {
        const workspacePackages = readBundledPluginWorkspacePackageSpecs(resolve('../..'));
        const directWorkspaceDependencies = readCliFirstPartyNonPluginDependencies();
        expect(workspacePackages.length).toBeGreaterThan(0);
        expect(workspacePackageOptimizationExcludes).toEqual(expect.arrayContaining([
            ...directWorkspaceDependencies,
            ...workspacePackages.map((workspacePackage) => workspacePackage.packageName),
        ]));

        for (const packageName of directWorkspaceDependencies) {
            const sourceRoot = resolve(
                '../../packages',
                packageName.slice('@happier-dev/'.length),
                'src',
            );
            expect(existsSync(sourceRoot), packageName).toBe(true);
            expect(
                normalize(workspacePackageSourcesPlugin.resolveId(packageName) ?? ''),
                packageName,
            ).toContain(normalize(sourceRoot));
        }

        for (const workspacePackage of workspacePackages) {
            const manifestPath = resolve(workspacePackage.packageSourceRoot, 'manifest.ts');
            expect(existsSync(manifestPath), workspacePackage.packageName).toBe(true);
            expect(
                normalize(workspacePackageSourcesPlugin.resolveId(
                    `${workspacePackage.packageName}/manifest`,
                ) ?? ''),
                workspacePackage.packageName,
            ).toBe(normalize(manifestPath));
        }
    });
});
