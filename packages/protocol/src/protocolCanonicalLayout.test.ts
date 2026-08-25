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
            './tools/v2/subAgentFamilies',
            './spawnSession',
            './rpc',
            './marketplace',
            './marketplace/internal',
            './crypto/base64',
            './crypto/canonicalDigest',
            './machines/administration/pluginMachineExecutionOriginV1',
            './actions',
            './actions/permissionPrivilege',
            './actions/actionSpecs',
            './actions/actionExecutionResult',
            './actions/actionInputHintsRuntime',
            './actions/actionInputJsonSchema',
            './actions/actionInputVoiceGuidance',
            './automations/event-setup-result',
            './automations/event',
            './automations/result-delivery',
            './automations/event-history-gap-reset-action',
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
            './sessions/creation/sessionSpawnNewInputV2',
            './sessions/general',
            './sessions/replay-seed-budget',
            './sessions/messages/special-commands',
            './sessions/subagents',
            './runtime',
            './bugs/reports',
            './diagnostics/sensitive-keys',
            './filesystem/portablePathSegment',
            './agents/runtimeDescriptorContributionsV1',
            './agents/claude',
            './backends',
            './daemon/plugin-invocation-logs',
            './pets',
            './plugins/ui',
            './plugins/ui/client',
            './plugins/ui/targetedContributions',
            './plugins/ui/composerRef',
            './plugins/actions/json-schema-validation',
            './plugins/actions/protocol-composable-schema',
            './plugins/errors',
            './plugins/contribution-identity',
            './plugins/source-spec',
            './plugins/contributions/system-tools',
            './plugins/plugin-id',
            './plugins/hooks',
            './plugins/agents',
            './plugins/manifest',
            './plugins/manifest/declaration',
            './plugins/availability',
            './providers',
            './providers/claude/oauth-profile',
            './providers/codex/oauth',
            './providers/contribution-identity',
            './providers/sensitive-value-redaction',
            './providers/credential-headers',
            './providers/ids',
            './providers/contributions',
            './providers/endpoint-url',
            './providers/public-headers',
            './providers/binding-compatibility',
            './providers/model-selection',
            './providers/active-model-selection',
            './connect/connected-account-purposes',
            './connect/connected-account-request-auth',
            './connect/connected-service-bindings',
            './connect/connected-service-schemas',
            './connect/account-usage-primitives',
            './connect/qualified-connected-account-projections',
            './connect/qualified-connected-account-persistence',
            './connect/connected-account-purpose-bindings',
            './connect/plugin-connected-account-authentication-v2',
            './connect/build-connected-service-credential-record',
            './connect/connected-service-limit-category',
            './account/settings/connected-services',
            './sessions/work-state',
            './sessions/metadata/runtime-descriptor',
            './sessions/metadata/runtime-descriptor-compat',
            './sessions/metadata/permission-modes',
            './sessions/metadata/overrides',
            './sessions/external/linked-metadata',
            './server/urls',
            './plugins/contributions/browser',
            './plugins/contributions/composer-attachments',
            './plugins/contributions/composer-reference-candidate-id',
            './plugins/contributions/voice',
            './plugins/contributions/ui',
            './plugins/contributions/ui/declarative-document-authoring',
            './plugins/contributions/ui/tokens',
            './plugins/contributions/webhooks',
            './plugins/webhooks/endpointV1',
            './plugins/webhooks/deliveryV1',
            './scm',
            './voice/realtime',
            './voice/providerOperations',
            './voice/prompt',
            './voice/speech',
            './voice/sessionBinding',
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

    it('publishes portable Session projection owners through cohesive domain subpaths', () => {
        const protocolExports = readProtocolExports();

        expect(protocolExports['./sessions/general']).toEqual({
            types: './dist/sessions/general.d.ts',
            default: './dist/sessions/general.js',
        });
        expect(protocolExports['./sessions/subagents']).toEqual({
            types: './dist/sessions/subagents/index.d.ts',
            default: './dist/sessions/subagents/index.js',
        });
    });

    it('publishes the Session spawn-input owner through its narrow browser-safe subpath', () => {
        const protocolExports = readProtocolExports();
        const target = protocolExports['./sessions/creation/sessionSpawnNewInputV2'];

        expect(target).toEqual({
            types: './dist/sessions/creation/sessionSpawnNewInputV2.d.ts',
            default: './dist/sessions/creation/sessionSpawnNewInputV2.js',
        });
        expect(existsSync(srcEntryForDistTarget(target?.default ?? ''))).toBe(true);
        expect(requireFromTest.resolve('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2'))
            .toBe(resolve(packageDir, target?.default ?? ''));
    });

    it('publishes the portable targeted-selection and JSON-schema owners through narrow leaves', () => {
        const protocolExports = readProtocolExports();
        const targetedSelection = protocolExports['./plugins/ui/targetedContributions'];
        const jsonSchemaValidation = protocolExports['./plugins/actions/json-schema-validation'];

        expect(targetedSelection).toEqual({
            types: './dist/plugins/ui/targetedContributions.d.ts',
            default: './dist/plugins/ui/targetedContributions.js',
        });
        expect(jsonSchemaValidation).toEqual({
            types: './dist/plugins/actions/jsonSchemaValidation.d.ts',
            default: './dist/plugins/actions/jsonSchemaValidation.js',
        });
        expect(requireFromTest.resolve('@happier-dev/protocol/plugins/ui/targetedContributions'))
            .toBe(resolve(packageDir, targetedSelection?.default ?? ''));
        expect(requireFromTest.resolve('@happier-dev/protocol/plugins/actions/json-schema-validation'))
            .toBe(resolve(packageDir, jsonSchemaValidation?.default ?? ''));
    });

    it('publishes the browser-safe declarative document authoring grammar through a narrow leaf', () => {
        const protocolExports = readProtocolExports();
        const declarativeDocumentAuthoring = protocolExports[
            './plugins/contributions/ui/declarative-document-authoring'
        ];

        expect(declarativeDocumentAuthoring).toEqual({
            types: './dist/plugins/contributions/ui/declarativeDocumentAuthoringV1.d.ts',
            default: './dist/plugins/contributions/ui/declarativeDocumentAuthoringV1.js',
        });
        expect(requireFromTest.resolve(
            '@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring',
        )).toBe(resolve(packageDir, declarativeDocumentAuthoring?.default ?? ''));
    });

    it('publishes browser-safe UI tokens through their narrow leaf', () => {
        const protocolExports = readProtocolExports();
        const tokens = protocolExports['./plugins/contributions/ui/tokens'];

        expect(tokens).toEqual({
            types: './dist/plugins/contributions/ui/tokens.d.ts',
            default: './dist/plugins/contributions/ui/tokens.js',
        });
        expect(requireFromTest.resolve('@happier-dev/protocol/plugins/contributions/ui/tokens'))
            .toBe(resolve(packageDir, tokens?.default ?? ''));
    });

    it('publishes the Webhook contribution grammar through its narrow leaf', () => {
        const protocolExports = readProtocolExports();
        const webhookContributions = protocolExports['./plugins/contributions/webhooks'];

        expect(webhookContributions).toEqual({
            types: './dist/plugins/contributions/webhooks.d.ts',
            default: './dist/plugins/contributions/webhooks.js',
        });
        expect(existsSync(srcEntryForDistTarget(webhookContributions?.default ?? ''))).toBe(true);
        expect(requireFromTest.resolve('@happier-dev/protocol/plugins/contributions/webhooks'))
            .toBe(resolve(packageDir, webhookContributions?.default ?? ''));
    });

    it('publishes the portable Automation Event setup-result owner through its narrow subpath', () => {
        const protocolExports = readProtocolExports();

        expect(protocolExports['./automations/event-setup-result']).toEqual({
            types: './dist/automations/automationEventSetupResultV1.d.ts',
            default: './dist/automations/automationEventSetupResultV1.js',
        });
    });

    it('publishes browser-safe Automation result-delivery schemas through their narrow subpath', () => {
        const protocolExports = readProtocolExports();
        const resultDelivery = protocolExports['./automations/result-delivery'];

        expect(resultDelivery).toEqual({
            types: './dist/automations/automationResultDeliveryV1.d.ts',
            default: './dist/automations/automationResultDeliveryV1.js',
        });
        expect(existsSync(srcEntryForDistTarget(resultDelivery?.default ?? ''))).toBe(true);
        expect(requireFromTest.resolve('@happier-dev/protocol/automations/result-delivery'))
            .toBe(resolve(packageDir, resultDelivery?.default ?? ''));
    });

    it('publishes Event history-gap declarations without the occurrence lifecycle owner', () => {
        const protocolExports = readProtocolExports();
        const historyGapResetAction = protocolExports['./automations/event-history-gap-reset-action'];

        expect(historyGapResetAction).toEqual({
            types: './dist/automations/automationEventHistoryGapResetActionV1.d.ts',
            default: './dist/automations/automationEventHistoryGapResetActionV1.js',
        });
        expect(requireFromTest.resolve('@happier-dev/protocol/automations/event-history-gap-reset-action'))
            .toBe(resolve(packageDir, historyGapResetAction?.default ?? ''));
    });

    it('publishes manifest declaration primitives without the ingestion owner', () => {
        const protocolExports = readProtocolExports();
        const manifestDeclaration = protocolExports['./plugins/manifest/declaration'];

        expect(manifestDeclaration).toEqual({
            types: './dist/plugins/manifest/declaration.d.ts',
            default: './dist/plugins/manifest/declaration.js',
        });
        expect(requireFromTest.resolve('@happier-dev/protocol/plugins/manifest/declaration'))
            .toBe(resolve(packageDir, manifestDeclaration?.default ?? ''));
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
