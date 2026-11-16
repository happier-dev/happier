import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { resolveInstallablesRegistry } from '@happier-dev/protocol/installables';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';

import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';

import { createProductionManagedDependencySourceAdapter } from './managedDependencySourceAdapters';
import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';
import { createStablePluginManagedDependenciesHost } from './managedDependencies';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

const processBoundary = vi.hoisted(() => ({ execFile: vi.fn() }));
// The operating-system process is the boundary; parsing, source resolution,
// dependency status and executable qualification remain real.
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
    execFileWithDeadline: processBoundary.execFile,
}));

const systemEnvironment = { PATH: dirname(process.execPath), PATHEXT: '.EXE;.CMD;.BAT', C55_SELECTED: 'selected' };
function systemHost(versionArguments?: string[], minimumVersion?: string) {
    const sourceModel = createV2ManagedDependencySourceModel({
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        architecture: process.arch,
        contributions: [{
            ...antigravityContribution(),
            definition: { id: 'system-tool', title: 'System tool', executable: basename(process.execPath),
                sources: [{ kind: 'system', executableNames: [basename(process.execPath)],
                    ...(versionArguments === undefined ? {} : { versionArguments }),
                    ...(minimumVersion === undefined ? {} : { minimumVersion }) }],
            },
        }],
    });
    return createStablePluginManagedDependenciesHost({
        installablesRegistry: resolveInstallablesRegistry({}), sourceModel,
        getSettings: () => ({}), env: systemEnvironment,
        resolveAdapter: async () => { throw new Error('Legacy adapter must not be used'); },
        resolveSourceAdapter: async (input) => createProductionManagedDependencySourceAdapter({ ...input,
            env: { PATH: '' },
        }),
        removeManagedInstall: async () => {}, removeManagedSource: async () => {},
    }).bind('happier.agent.antigravity');
}

function antigravityContribution(
    sourceKind: 'bundled' | 'package' = 'bundled',
): ResolvedInstallableContribution {
    return {
        provenance: sourceKind === 'bundled' ? 'first_party' : 'external',
        source: { kind: sourceKind },
        pluginId: 'happier.agent.antigravity',
        manifestPath: `${sourceKind}:happier.agent.antigravity`,
        daemonEntryPath: null,
        sourceSpec: {
            kind: sourceKind,
            locator: sourceKind === 'bundled'
                ? '@happier-dev/plugins-antigravity'
                : '@acme/antigravity',
            trustPolicy: sourceKind === 'bundled' ? 'local_trusted' : 'prompt',
            installPolicy: sourceKind === 'bundled' ? 'copy' : 'managed_install',
            ...(sourceKind === 'package'
                ? {
                    resolvedVersion: '1.0.0',
                }
                : {}),
        },
        definition: {
            id: 'localharness',
            title: 'Antigravity localharness',
            executable: 'localharness',
            sources: [{
                kind: 'managedPypiWheelAsset',
                installId: 'dep.antigravity.localharness',
                distribution: 'google-antigravity',
                versionSpecifier: '>=0.1.4,<0.2.0',
                assetPathByPlatform: {
                    'darwin-arm64': 'google/antigravity/bin/localharness',
                    'linux-x64': 'google/antigravity/bin/localharness',
                    'linux-arm64': 'google/antigravity/bin/localharness',
                    'win32-x64': 'google/antigravity/bin/localharness.exe',
                    'win32-arm64': 'google/antigravity/bin/localharness.exe',
                },
                executable: true,
                compatibilityProbe: 'antigravity-localharness-v1',
                installConsent: 'host_managed_required',
                autoUpdateMode: 'notify',
                trustedPublisher: 'Google',
            }],
        },
    };
}

function antigravityPinnedContribution(
    facts: Readonly<{ version: string; sha256: string }> = { version: '1.1.1', sha256: 'a'.repeat(64) },
): ResolvedInstallableContribution {
    const asset = Object.freeze({
        archiveUrl: `https://dl.google.com/agy-acp-server-${facts.version}.zip`,
        sha256: facts.sha256,
        executableSubpath: 'agy_acp_server.par',
    });
    return {
        ...antigravityContribution(),
        definition: {
            id: 'agy-acp-server',
            title: 'Antigravity ACP server',
            executable: 'agy_acp_server',
            sources: [{
                kind: 'pinnedArchive',
                installId: 'dep.antigravity.agy-acp-server',
                version: facts.version,
                archiveExtractionLimits: {
                    maxArchiveBytes: 1024 * 1024 * 1024,
                    maxFileBytes: 2 * 1024 * 1024 * 1024,
                    maxExpandedBytes: 2 * 1024 * 1024 * 1024,
                    timeoutMs: 10 * 60_000,
                },
                assetsByPlatform: {
                    'darwin-arm64': asset,
                    'linux-x64': asset,
                    'linux-arm64': asset,
                    'win32-x64': asset,
                    'win32-arm64': asset,
                },
            }],
        },
    };
}

function sourceFrom(
    contribution: ResolvedInstallableContribution,
    identity: Readonly<{ localId: string; installId: string }> = {
        localId: 'localharness',
        installId: 'dep.antigravity.localharness',
    },
) {
    const model = createV2ManagedDependencySourceModel({
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        architecture: process.arch,
        contributions: [contribution],
    });
    const dependency = model.resolve({
        pluginId: 'happier.agent.antigravity',
        localId: identity.localId,
    });
    const sourceInstallable = resolveExecutableManagedDependenciesRegistry(
        [contribution],
        {
            platform: process.platform,
            architecture: process.arch,
        },
    ).descriptorsByKey[identity.installId]?.descriptor;
    if (!sourceInstallable) throw new Error('Expected canonical managed source installable');
    return { dependency, source: dependency.sources[0]!, sourceInstallable };
}

const PINNED_IDENTITY = Object.freeze({
    localId: 'agy-acp-server',
    installId: 'dep.antigravity.agy-acp-server',
});

describe('createProductionManagedDependencySourceAdapter', () => {
    it('resolves system tools and probes their version in the captured source directory', async () => {
        const root = createTempDirSync('happier-source-directory-');
        const nativeExecFile = promisify(execFile);
        processBoundary.execFile.mockReset().mockImplementation((command, args, options) => nativeExecFile(command, args, options));
        try {
            const contribution = {
                ...antigravityContribution(),
                definition: { id: 'system-tool', title: 'System tool', executable: 'cwd-tool',
                    sources: [{ kind: 'system' as const, executableNames: ['cwd-tool'], versionArguments: ['--version'] }],
                },
            };
            const model = createV2ManagedDependencySourceModel({
                platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
                architecture: process.arch, contributions: [contribution],
            });
            const pluginId = contribution.pluginId;
            if (!pluginId) throw new Error('Expected qualified system-tool contribution');
            const dependency = model.resolve({ pluginId, localId: 'system-tool' });
            const results = await Promise.all(['source-a', 'source-b'].map(async (name) => {
                const cwd = join(root, name);
                const bin = join(cwd, 'bin');
                mkdirSync(bin, { recursive: true });
                const script = join(cwd, 'version.cjs');
                writeFileSync(script, "if(process.cwd()!==process.env.SOURCE_DIRECTORY)process.exit(7);process.stdout.write('cwd-tool 1.2.3');");
                const executable = writeExecutableShimSync({
                    dir: bin, fileName: process.platform === 'win32' ? 'cwd-tool.cmd' : 'cwd-tool',
                    contents: process.platform === 'win32'
                        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
                        : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script.replace(/'/g, `'\\''`)}' "$@"\n`,
                });
                return await Promise.all(['bin', bin].map(async (path) => {
                    const adapter = await createProductionManagedDependencySourceAdapter({
                        dependency, source: dependency.sources[0]!, cwd,
                        env: { NODE_ENV: 'test', PATH: path, PATHEXT: '.EXE;.CMD;.BAT', SOURCE_DIRECTORY: cwd },
                    });
                    if (!adapter.detectCapabilityStatus) throw new Error('Expected system source capability probe');
                    return { launch: await adapter.resolveLaunchCommand?.(),
                        status: await adapter.detectCapabilityStatus(), executable };
                }));
            }));
            expect(results).toMatchObject(results.map((group) => group.map(({ executable }) => ({
                launch: { ok: true, command: executable }, status: { version: '1.2.3' },
            }))));
        } finally {
            removeTempDirSync(root);
        }
    });

    it('publishes the qualified system version from declared native version arguments', async () => {
        processBoundary.execFile.mockReset().mockResolvedValue({ stdout: 'Version: v0.46.0\nCommit: 991967\n', stderr: '' });
        expect(await systemHost(['version']).status('system-tool')).toMatchObject({ state: 'ready', version: '0.46.0' });
        expect(processBoundary.execFile).toHaveBeenCalledWith(process.execPath, ['version'], expect.objectContaining({ env: systemEnvironment }));
    });

    it('publishes the system version from a bare `<executable> <version>` probe line', async () => {
        // `cua --version` prints `cua 0.5.0` with no `version` word.
        processBoundary.execFile.mockReset().mockResolvedValue({ stdout: `${basename(process.execPath)} 0.5.0\n`, stderr: '' });
        expect(await systemHost(['--version']).status('system-tool')).toMatchObject({ state: 'ready', version: '0.5.0' });
    });

    it('keeps system versions unknown when the declared probe fails or is absent', async () => {
        processBoundary.execFile.mockReset().mockRejectedValue(Object.assign(new Error('Native probe failed'),
            { exitCode: 1, stdout: 'Version: v0.46.0\n', stderr: '' }));
        expect(await systemHost(['version']).status('system-tool')).toMatchObject({ state: 'ready', version: 'unknown' });
        processBoundary.execFile.mockClear();
        expect(await systemHost().status('system-tool')).toMatchObject({ state: 'ready', version: 'unknown' });
        expect(processBoundary.execFile).not.toHaveBeenCalled();
    });

    it.each(['0.5.0', '0.27.5-rc.1', 'unreadable'])('does not qualify system version %s below its declared prerequisite', async (version) => {
        processBoundary.execFile.mockReset().mockResolvedValue({ stdout: `${basename(process.execPath)} ${version}\n`, stderr: '' });
        expect(await systemHost(['--version'], '0.27.5').status('system-tool')).toMatchObject({ state: 'missing' });
        expect(processBoundary.execFile).toHaveBeenCalledTimes(1);
    });

    it('retains compatible system installs ahead of managed acquisition', async () => {
        processBoundary.execFile.mockReset().mockResolvedValue({ stdout: `${basename(process.execPath)} 0.27.5\n`, stderr: '' });
        expect(await systemHost(['--version'], '0.27.5').status('system-tool')).toMatchObject({ state: 'ready', version: '0.27.5' });
        expect(processBoundary.execFile).toHaveBeenCalledTimes(1);
    });

    it('does not qualify failed version probes even if their failed output contains a compatible version', async () => {
        processBoundary.execFile.mockReset().mockRejectedValue(Object.assign(new Error('Probe failed'), {
            exitCode: 1, stdout: `${basename(process.execPath)} 0.28.0\n`, stderr: '',
        }));
        expect(await systemHost(['--version'], '0.27.5').status('system-tool')).toMatchObject({ state: 'missing' });
    });

    it('uses the installed managed pin after upgrade when PATH still contains the outdated system tool', async () => {
        const root = createTempDirSync('happier-qualified-system-');
        try {
            const env = { ...systemEnvironment, HAPPIER_HOME_DIR: root };
            const original = antigravityPinnedContribution({ version: '0.27.5', sha256: 'a'.repeat(64) });
            const contribution = { ...original, definition: {
                ...original.definition,
                sources: [{ kind: 'system' as const, executableNames: [basename(process.execPath)],
                    versionArguments: ['--version'], minimumVersion: '0.27.5' },
                    ...('sources' in original.definition ? original.definition.sources : [])],
            } };
            const sourceModel = createV2ManagedDependencySourceModel({ platform: 'linux', architecture: 'x64', contributions: [contribution] });
            const installablesRegistry = resolveExecutableManagedDependenciesRegistry([contribution]);
            const host = createStablePluginManagedDependenciesHost({
                sourceModel, installablesRegistry, env, getSettings: () => ({}),
                resolveAdapter: async () => { throw new Error('Unexpected legacy source'); },
                resolveSourceAdapter: input => createProductionManagedDependencySourceAdapter({ ...input, env, platform: 'linux', architecture: 'x64' }),
                removeManagedInstall: async () => {}, removeManagedSource: async () => {},
            });
            const bound = host.bind('happier.agent.antigravity');
            processBoundary.execFile.mockReset().mockResolvedValue({ stdout: 'agy_acp_server 0.5.0\n', stderr: '' });
            expect(await bound.status(PINNED_IDENTITY.localId)).toMatchObject({ state: 'missing' });
            // Native installer effect: exact executable plus the install owner's version/digest receipts.
            const current = join(resolveManagedToolsRoot(env), PINNED_IDENTITY.installId, 'current');
            mkdirSync(current, { recursive: true });
            const contents = '#!/bin/sh\nexit 0\n';
            const command = join(current, 'agy_acp_server.par');
            writeFileSync(command, contents, { mode: 0o755 });
            writeFileSync(join(current, '.happier-managed-version'), '0.27.5');
            writeFileSync(join(current, '.happier-managed-executable-sha256'), `sha256:${createHash('sha256').update(contents).digest('hex')}`);
            expect(await bound.status(PINNED_IDENTITY.localId)).toMatchObject({ state: 'ready', version: '0.27.5' });
            const lease = await host.resolveExecutable({ kind: 'managedDependency', id: PINNED_IDENTITY.localId }, 'happier.agent.antigravity', { requireReady: true });
            expect(lease.command).toBe(command);
            lease.release();
            processBoundary.execFile.mockResolvedValue({ stdout: 'agy_acp_server 0.28.0\n', stderr: '' });
            expect(await bound.status(PINNED_IDENTITY.localId)).toMatchObject({ state: 'ready', version: '0.28.0' });
        } finally { removeTempDirSync(root); }
    });

    it('refuses a managed PyPI source without its canonical source-acquisition installable', async () => {
        const { sourceInstallable: _sourceInstallable, ...input } = sourceFrom(
            antigravityContribution(),
        );

        await expect(createProductionManagedDependencySourceAdapter(input))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_source_invalid' });
    });

    it('adapts a bundled managed PyPI wheel declaration through the canonical install owner', async () => {
        const adapter = await createProductionManagedDependencySourceAdapter(
            sourceFrom(antigravityContribution()),
        );

        expect(adapter).toMatchObject({
            key: 'dep.antigravity.localharness',
            capabilityId: 'dep.antigravity.localharness',
        });
        expect(adapter.resolveLaunchCommand).toEqual(expect.any(Function));
    });

    it.each([
        ['darwin', 'arm64'],
        ['linux', 'x64'],
        ['linux', 'arm64'],
        ['win32', 'x64'],
        ['win32', 'arm64'],
    ] as const)('accepts the declared %s/%s wheel asset', async (platform, architecture) => {
        await expect(createProductionManagedDependencySourceAdapter({
            ...sourceFrom(antigravityContribution()),
            platform,
            architecture,
        })).resolves.toMatchObject({
            key: 'dep.antigravity.localharness',
        });
    });

    it('rejects an undeclared macOS x64 asset instead of reporting a supported missing install', async () => {
        await expect(createProductionManagedDependencySourceAdapter({
            ...sourceFrom(antigravityContribution()),
            platform: 'darwin',
            architecture: 'x64',
        })).rejects.toMatchObject({
            code: 'plugin_managed_dependency_architecture_unsupported',
        });
    });

    it('refuses a pinned archive source without its canonical source-acquisition installable', async () => {
        const { sourceInstallable: _sourceInstallable, ...input } = sourceFrom(
            antigravityPinnedContribution(),
            PINNED_IDENTITY,
        );

        await expect(createProductionManagedDependencySourceAdapter(input))
            .rejects.toMatchObject({ code: 'plugin_managed_dependency_source_invalid' });
    });

    it('refuses a pinned archive source whose canonical installable pins different immutable artifact facts', async () => {
        const losing = sourceFrom(antigravityPinnedContribution({
            version: '9.9.9',
            sha256: 'b'.repeat(64),
        }), PINNED_IDENTITY);
        const { sourceInstallable } = sourceFrom(
            antigravityPinnedContribution(),
            PINNED_IDENTITY,
        );

        await expect(createProductionManagedDependencySourceAdapter({
            ...losing,
            sourceInstallable,
        })).rejects.toMatchObject({ code: 'plugin_managed_dependency_source_invalid' });
    });

    it('adapts a pinned archive declaration through the canonical descriptor install owner', async () => {
        await expect(createProductionManagedDependencySourceAdapter(
            sourceFrom(antigravityPinnedContribution(), PINNED_IDENTITY),
        )).resolves.toMatchObject({
            key: 'dep.antigravity.agy-acp-server',
            capabilityId: 'dep.antigravity.agy-acp-server',
        });
    });

    it('adapts a trusted installed external package without a provenance capability gate', async () => {
        await expect(createProductionManagedDependencySourceAdapter(
            sourceFrom(antigravityContribution('package')),
        )).resolves.toMatchObject({
            key: 'dep.antigravity.localharness',
            capabilityId: 'dep.antigravity.localharness',
        });
    });
});
