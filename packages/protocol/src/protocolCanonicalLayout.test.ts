import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, '..');
const repoRootDir = resolve(packageDir, '../..');
const requireFromTest = createRequire(import.meta.url);
const REPOSITORY_LAYOUT_SCAN_TIMEOUT_MS = 15_000;

const allowedRootEntries = new Set([
    'index.ts',
    'index.exports.test.ts',
    'protocolCanonicalLayout.test.ts',
    'agents',
]);

const forbiddenRootEntries = new Set([
    'acpCatalog',
    'backendTargets',
    'bugReports',
    'bugReports.ts',
    'bugReports.fallback.test.ts',
    'bugReports.reporter.test.ts',
    'bugReports.serverDiagnostics.test.ts',
    'bugReports.similarIssues.test.ts',
    'bugReports.submit.test.ts',
    'daemonContributionRegistryProjection.ts',
    'daemonContributionRegistryProjection.test.ts',
    'daemonExecutionRuns.ts',
    'daemonExecutionRuns.test.ts',
    'daemonTerminal.ts',
    'daemonVoiceInference.ts',
    'daemonVoiceInference.test.ts',
    'executionRunListRequest.ts',
    'executionRunStartRequest.ts',
    'executionRuns.ts',
    'executionRuns.streaming.test.ts',
    'executionRuns.test.ts',
    'installables.test.ts',
    'installables.ts',
    'liveActivities',
    'llmTasks',
    'machineFileBrowser.ts',
    'machineFileBrowser.test.ts',
    'machineHost',
    'machineIdentity',
    'machineOwnership',
    'machineTransfer',
    'mcpServers',
    'promptLibrary',
    'rpc.ts',
    'rpc.daemonExecutionRuns.test.ts',
    'rpc.daemonTerminal.test.ts',
    'rpc.directSessions.test.ts',
    'rpc.executionRuns.test.ts',
    'rpc.fileSystem.test.ts',
    'rpc.marketplaceSourceRegistry.test.ts',
    'rpc.mcpServers.test.ts',
    'rpc.memory.test.ts',
    'rpc.promptAssets.test.ts',
    'rpc.promptRegistries.test.ts',
    'rpc.scm.test.ts',
    'rpc.serverWork.test.ts',
    'rpc.sessionFork.test.ts',
    'rpc.sessionHandoff.test.ts',
    'rpc.sessionReplay.test.ts',
    'rpc.sessionRollback.test.ts',
    'rpc.sshTunnels.test.ts',
    'rpc.usageLimitRecovery.test.ts',
    'rpc.voiceInference.test.ts',
    'rpc.wireCompatibility.test.ts',
    'rpcErrors.ts',
    'rpcErrors.test.ts',
    'scm.ts',
    'scm.contract.test.ts',
    'scmBackendCapabilities.ts',
    'scmBackendCapabilities.test.ts',
    'scmBranches.ts',
    'scmBranches.contract.test.ts',
    'scmCapabilities.ts',
    'scmCapabilities.test.ts',
    'scmDiffSummary.ts',
    'scmDiffSummary.cache.test.ts',
    'scmDiffSummary.test.ts',
    'scmFreshness.ts',
    'scmFreshness.test.ts',
    'scmPathScope.ts',
    'scmPathScope.test.ts',
    'scmPolicy.ts',
    'scmPolicy.test.ts',
    'scmPullRequests.ts',
    'scmPullRequests.contract.test.ts',
    'scmPullRequests.test.ts',
    'scmRepositoryClone.ts',
    'scmRepositoryClone.test.ts',
    'scmRepositoryProvisioning.ts',
    'scmRepositoryProvisioning.test.ts',
    'scmStash.ts',
    'scmStash.contract.test.ts',
    'scmWorktrees.ts',
    'scmWorktrees.contract.test.ts',
    'serverControl',
    'serverUrls',
    'session',
    'sessionAuthoring',
    'sessionChanges',
    'sessionContinueWithReplay.ts',
    'sessionContinueWithReplay.test.ts',
    'sessionContinueWithReplayCompat.ts',
    'sessionControl',
    'sessionFolders',
    'sessionFork.ts',
    'sessionFork.test.ts',
    'sessionMessages',
    'sessionMetadata',
    'sessionRollback.ts',
    'sessionRollback.test.ts',
    'sessionRollbackPlanning.ts',
    'sessionRollbackPlanning.test.ts',
    'sessionSystemRecords',
    'sessionUserMessageRpc.ts',
    'sessionUserMessageRpc.test.ts',
    'sessionWorkState',
    'settingsRegistry',
    'socketRpc.ts',
    'socketRpc.test.ts',
    'structuredMessages',
    'systemTasks',
    'transferRelayV2',
    'transferSessions',
    'updates.ts',
    'updates.accountSettings.test.ts',
    'updates.automation.test.ts',
    'updates.forwardCompat.test.ts',
    'updates.sharing.test.ts',
    'updates.transcript.test.ts',
    'voiceActions.ts',
    'voiceActions.test.ts',
]);

type PackageExportTarget = Readonly<{
    types?: string;
    default?: string;
}>;

function readProtocolExports(): Record<string, PackageExportTarget> {
    const raw = readFileSync(resolve(packageDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { exports?: Record<string, PackageExportTarget> };
    return parsed.exports ?? {};
}

function srcEntryForDistTarget(target: string): string {
    return resolve(packageDir, target.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts'));
}

function collectSourceFiles(relativeRoot: string): string[] {
    const absoluteRoot = resolve(repoRootDir, relativeRoot);
    if (!existsSync(absoluteRoot)) {
        return [];
    }

    const files: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.project') {
                continue;
            }
            const absolutePath = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '__tests__') {
                    continue;
                }
                visit(absolutePath);
                continue;
            }
            if (
                entry.isFile()
                && /\.[cm]?[tj]sx?$/.test(entry.name)
                && !/(\.test|\.spec)\.[cm]?[tj]sx?$/.test(entry.name)
            ) {
                files.push(absolutePath);
            }
        }
    };
    visit(absoluteRoot);
    return files;
}

describe('protocol canonical layout', () => {
    it('keeps A.17-owned flat protocol root entries folded into canonical domains', () => {
        const rootEntries = new Set(readdirSync(srcDir));
        const violations = [...forbiddenRootEntries].filter((entry) => rootEntries.has(entry));

        expect(violations).toEqual([]);
        for (const entry of allowedRootEntries) {
            expect(rootEntries.has(entry)).toBe(true);
        }
    });

    it('keeps Codex protocol facts in generated/runtime or plugin-owned leaves', () => {
        expect(existsSync(resolve(srcDir, 'agents/codex'))).toBe(false);
        expect(existsSync(resolve(srcDir, 'agents/generated/runtime/descriptors/codex.ts'))).toBe(true);
    });

    it('keeps published package subpath specifiers mapped to source entrypoints', () => {
        const protocolExports = readProtocolExports();

        expect(Object.keys(protocolExports)).toEqual([
            '.',
            './tools/v2',
            './spawnSession',
            './rpc',
            './marketplace/internal',
            './actions',
            './actions/permissionPrivilege',
            './actions/actionSpecs',
            './rpcErrors',
            './checklists',
            './installables',
            './installablesPolicy',
            './testing/accountScopedCipherFixtures',
            './host/legacyConnectedServiceQuotaCompatibility',
            './capabilities',
            './socketRpc',
            './changes',
            './transferRelayV2',
            './transferSessions',
            './updates',
            './workspaces',
            './sessions',
            './runtime',
            './filesystem/portablePathSegment',
            './agents/runtimeDescriptorContributionsV1',
            './backends',
            './pets',
            './plugins/ui',
            './plugins/hooks',
            './plugins/contributions/browser',
            './plugins/contributions/ui',
            './voice/modelPacks/contributionV1',
        ]);

        for (const [specifier, target] of Object.entries(protocolExports)) {
            expect(target.default, specifier).toMatch(/^\.\/dist\/.*\.js$/);
            expect(target.types, specifier).toMatch(/^\.\/dist\/.*\.d\.ts$/);
            expect(existsSync(srcEntryForDistTarget(target.default ?? '')), specifier).toBe(true);

            const packageSpecifier =
                specifier === '.'
                    ? '@happier-dev/protocol'
                    : `@happier-dev/protocol${specifier.slice(1)}`;
            const resolved = requireFromTest.resolve(packageSpecifier);
            expect(resolved, packageSpecifier).toBe(resolve(packageDir, target.default ?? ''));
        }
    });

    it('keeps live host code from importing protocol extension compatibility modules directly', () => {
        const violations = [
            'apps/cli/src',
            'apps/ui/sources',
            'packages/plugin-sdk/src',
        ].flatMap((root) => collectSourceFiles(root))
            .filter((filePath) => /protocol\/src\/extensions|@happier-dev\/protocol\/src\/extensions/.test(
                readFileSync(filePath, 'utf8'),
            ))
            .map((filePath) => filePath.slice(repoRootDir.length + 1).replaceAll('\\', '/'))
            .sort();

        expect(violations).toEqual([]);
    }, REPOSITORY_LAYOUT_SCAN_TIMEOUT_MS);
});
