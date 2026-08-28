import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const protocolRoot = resolve(import.meta.dirname, '../../protocol/src/index.ts');
const protocolAutomationResultDelivery = resolve(
    import.meta.dirname,
    '../../protocol/src/automations/automationResultDeliveryV1.ts',
);
const protocolAutomationEventSetupResult = resolve(
    import.meta.dirname,
    '../../protocol/src/automations/automationEventSetupResultV1.ts',
);
const protocolSessionSpawnNewInput = resolve(
    import.meta.dirname,
    '../../protocol/src/sessions/creation/sessionSpawnNewInputV2.ts',
);
const protocolPluginMachineExecutionOrigin = resolve(
    import.meta.dirname,
    '../../protocol/src/machines/administration/pluginMachineExecutionOriginV1.ts',
);
const protocolAccountScopedCipher = resolve(
    import.meta.dirname,
    '../../protocol/src/crypto/accountScopedCipher.ts',
);
const protocolClaudeSubscriptionMaterialization = resolve(
    import.meta.dirname,
    '../../protocol/src/connect/claudeSubscriptionMaterialization.ts',
);
const protocolDeclarativeDocument = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/contributions/ui/declarativeDocument.ts',
);
const protocolManifest = resolve(import.meta.dirname, '../../protocol/src/plugins/manifest/index.ts');
const protocolJsonSchemaValidation = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/actions/jsonSchemaValidation.ts',
);
const sourceAliases = [
    ['@happier-dev/protocol/providers/contribution-identity', '../../protocol/src/providers/contributionIdentityV1.ts'],
    ['@happier-dev/protocol/providers/sensitive-value-redaction', '../../protocol/src/providers/safety/redaction.ts'],
    ['@happier-dev/protocol/providers/credential-headers', '../../protocol/src/providers/safety/headers.ts'],
    ['@happier-dev/protocol/providers/ids', '../../protocol/src/providers/ids.ts'],
    ['@happier-dev/protocol/providers/contributions', '../../protocol/src/providers/contributions/v1.ts'],
    ['@happier-dev/protocol/providers/endpoint-url', '../../protocol/src/providers/endpointUrlSchema.ts'],
    ['@happier-dev/protocol/providers/public-headers', '../../protocol/src/providers/publicHeadersSchema.ts'],
    ['@happier-dev/protocol/providers/binding-compatibility', '../../protocol/src/providers/compatibility/resolve.ts'],
    ['@happier-dev/protocol/providers/model-selection', '../../protocol/src/providers/selection/v1.ts'],
    ['@happier-dev/protocol/providers/claude/oauth-profile', '../../protocol/src/providers/claude/oauthProfile.ts'],
    ['@happier-dev/protocol/providers/codex/oauth', '../../protocol/src/providers/codex/oauth.ts'],
    ['@happier-dev/protocol/connect/connected-account-purposes', '../../protocol/src/connect/connectedAccountPurposes.ts'],
    ['@happier-dev/protocol/connect/claude-subscription-materialization', '../../protocol/src/connect/claudeSubscriptionMaterialization.ts'],
    ['@happier-dev/protocol/connect/connected-account-request-auth', '../../protocol/src/connect/connectedAccountRequestAuth.ts'],
    ['@happier-dev/protocol/connect/connected-service-bindings', '../../protocol/src/connect/connectedServiceBindings.ts'],
    ['@happier-dev/protocol/connect/connected-service-schemas', '../../protocol/src/connect/connectedServiceSchemas.ts'],
    ['@happier-dev/protocol/connect/account-usage-primitives', '../../protocol/src/connect/providerAccountUsagePrimitives.ts'],
    ['@happier-dev/protocol/connect/qualified-connected-account-projections', '../../protocol/src/connect/qualifiedConnectedAccountProjectionsV4.ts'],
    ['@happier-dev/protocol/connect/qualified-connected-account-persistence', '../../protocol/src/connect/qualifiedConnectedAccountPersistence.ts'],
    ['@happier-dev/protocol/connect/connected-account-purpose-bindings', '../../protocol/src/connect/connectedAccountPurposeBindings.ts'],
    ['@happier-dev/protocol/connect/build-connected-service-credential-record', '../../protocol/src/connect/buildConnectedServiceCredentialRecord.ts'],
    ['@happier-dev/protocol/connect/connected-service-limit-category', '../../protocol/src/connect/connectedServiceLimitCategory.ts'],
    ['@happier-dev/protocol/account/settings/connected-services', '../../protocol/src/account/settings/connectedServicesSettings.ts'],
    ['@happier-dev/protocol/sessions/work-state', '../../protocol/src/sessions/work/state/index.ts'],
    ['@happier-dev/protocol/sessions/general', '../../protocol/src/sessions/general.ts'],
    ['@happier-dev/protocol/sessions/subagents', '../../protocol/src/sessions/subagents/index.ts'],
    ['@happier-dev/protocol/runtime', '../../protocol/src/runtime/index.ts'],
    ['@happier-dev/protocol/tools/v2/subAgentFamilies', '../../protocol/src/tools/v2/subAgentFamilies.ts'],
    ['@happier-dev/protocol/tools/v2', '../../protocol/src/tools/v2/index.ts'],
    ['@happier-dev/protocol/actions/actionSpecs', '../../protocol/src/actions/actionSpecs.ts'],
    ['@happier-dev/protocol/actions/actionInputHintsRuntime', '../../protocol/src/actions/actionInputHintsRuntime.ts'],
    ['@happier-dev/protocol/actions/externalActionLimits', '../../protocol/src/actions/externalActionLimits.ts'],
    ['@happier-dev/protocol/plugins/settings/accountSettingsLimits', '../../protocol/src/plugins/settings/accountSettingsLimits.ts'],
    ['@happier-dev/protocol/actions', '../../protocol/src/actions/index.ts'],
    ['@happier-dev/protocol/automations/result-delivery', '../../protocol/src/automations/automationResultDeliveryV1.ts'],
    ['@happier-dev/protocol/automations/event-setup-result', '../../protocol/src/automations/automationEventSetupResultV1.ts'],
    ['@happier-dev/protocol/automations/event-history-gap-reset-action', '../../protocol/src/automations/automationEventHistoryGapResetActionV1.ts'],
    ['@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2', '../../protocol/src/sessions/creation/sessionSpawnNewInputV2.ts'],
    ['@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1', '../../protocol/src/machines/administration/pluginMachineExecutionOriginV1.ts'],
    ['@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring', '../../protocol/src/plugins/contributions/ui/declarativeDocumentAuthoringV1.ts'],
    ['@happier-dev/protocol/sessions/metadata/runtime-descriptor', '../../protocol/src/sessions/metadata/runtimeDescriptorV1.ts'],
    ['@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat', '../../protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.ts'],
    ['@happier-dev/agents/runtime/connected-services-adapter', '../../agents/src/runtime/adjunctAdapters/connectedServices.ts'],
    ['@happier-dev/agents/runtime/identity/session-metadata', '../../agents/src/runtime/identity/readSessionMetadataRuntimeDescriptor.ts'],
    ['@happier-dev/agents/acpPresets', '../../agents/src/acpPresets.ts'],
    ['@happier-dev/agents/permissions', '../../agents/src/permissions/index.ts'],
    ['@happier-dev/agents/runtime/session/runtimeConfigUpdateOutcome', '../../agents/src/runtime/session/runtimeConfigUpdateOutcome.ts'],
    ['@happier-dev/agents/session/state/metadataReaders', '../../agents/src/session/state/metadataReaders.ts'],
    ['@happier-dev/agents/runtime/session/recoverableTurnFailurePolicy', '../../agents/src/runtime/session/recoverableTurnFailurePolicy.ts'],
    ['@happier-dev/agents/runtime/terminal/promptWriteTimeout', '../../agents/src/runtime/terminal/promptWriteTimeout.ts'],
    ['@happier-dev/agents/session/controls/metadataKeys', '../../agents/src/session/controls/metadataKeys.ts'],
    ['@happier-dev/agents/session/state/bindings/metadataKeys', '../../agents/src/session/state/bindings/metadataKeys.ts'],
    ['@happier-dev/agents/session/controls/vendorResumePolicy', '../../agents/src/session/controls/vendorResumePolicy.ts'],
] as const;

const bundleCases = [
    {
        name: 'Connected Accounts projection',
        entry: resolve(import.meta.dirname, './connectedAccounts.ts'),
        source: 'export * from ENTRY;',
    },
    {
        name: 'Connected Accounts request-auth author helper',
        entry: resolve(import.meta.dirname, './connected-accounts/requestAuth.ts'),
        source: 'export { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV, buildConnectedAccountRequestAuthClientSource } from ENTRY;',
    },
    {
        name: 'Provider projection',
        entry: resolve(import.meta.dirname, './providers/projections.ts'),
        source: 'export * from ENTRY;',
    },
    {
        name: 'public protocol-authoring facade',
        entry: resolve(import.meta.dirname, './protocol/protocolFacade.ts'),
        source: 'export { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from ENTRY;',
    },
    {
        name: 'Protocol Agent Session runtime schema',
        entry: resolve(import.meta.dirname, '../../protocol/src/runtime/index.ts'),
        source: 'export { AgentSessionRuntimeEventV1Schema } from ENTRY;',
    },
    {
        name: 'Protocol Agent Session provider-binding schema',
        entry: resolve(
            import.meta.dirname,
            '../../protocol/src/providers/sessions/bindingMetadataV1.ts',
        ),
        source: 'export { AgentSessionProviderBindingV1Schema } from ENTRY;',
    },
    {
        name: 'Work State publication projection',
        entry: resolve(import.meta.dirname, './sessions/workState.ts'),
        source: 'export { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS } from ENTRY;',
    },
    {
        name: 'Agent runtime publication projection',
        entry: resolve(import.meta.dirname, './agentRuntime/projections.ts'),
        source: 'export { AgentProviderBindingMaterializationV1Schema } from ENTRY;',
    },
    {
        name: 'General Sessions publication projection',
        entry: resolve(import.meta.dirname, './services/sessions.ts'),
        source: 'export { CHANGE_TITLE_TOOL_NAME_ALIASES } from ENTRY;',
    },
    {
        name: 'Session input canonical projection',
        entry: resolve(import.meta.dirname, './sessions/index.ts'),
        source: 'export { AgentPermissionIntentV1Schema, SessionAuthoringCheckoutCreationDraftV1Schema, SessionIdSchema, SessionIndexedIdentifierMaxLengthV1, SessionSpawnNewInputV2Schema } from ENTRY;',
    },
    {
        name: 'Secrets schema publication projection',
        entry: resolve(import.meta.dirname, './secrets.ts'),
        source: 'export { SecretStringV1Schema } from ENTRY;',
    },
    {
        name: 'Agent runtime testkit publication projection',
        entry: resolve(import.meta.dirname, './testing/runtimeEvents.ts'),
        source: 'export { createAgentSessionRuntimeHarness } from ENTRY;',
    },
    {
        name: 'Subagent publication projection',
        entry: resolve(import.meta.dirname, './sessions/subagents.ts'),
        source: 'export { parseParticipantMessageV1 } from ENTRY;',
    },
    {
        name: 'Automation result-delivery projection',
        entry: resolve(import.meta.dirname, './automations.ts'),
        source: 'export { AutomationConversationAdmitInputV1Schema, AutomationResultDeliveryInputV1Schema } from ENTRY;',
    },
    {
        name: 'Events publication projection',
        entry: resolve(import.meta.dirname, './events/index.ts'),
        source: 'export { admitCheckpointedPluginEventObservationV1, createPluginEventAutomationSetupResultV1JsonSchema, PluginEventAutomationSetupResultV1Schema } from ENTRY;',
    },
    {
        name: 'Action author projection',
        entry: resolve(import.meta.dirname, './actions/index.public.ts'),
        source: `export {
          PluginMachineExecutionOriginV1Schema,
          actionInputOptionValueKey,
          getActionSpec,
          isSameActionInputOptionValue,
          normalizeActionInputByFieldHints,
          readActionInputOptionValue,
          resolveEffectiveActionInputFields,
        } from ENTRY;`,
    },
    {
        name: 'Settings limits projection',
        entry: resolve(import.meta.dirname, './settings/projections.ts'),
        source: 'export { PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 } from ENTRY;',
    },
    {
        name: 'Declarative document content-type projection',
        entry: resolve(import.meta.dirname, './ui/declarativeDocument.ts'),
        source: 'export { PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 } from ENTRY;',
    },
] as const;

async function bundleNodeReach(bundleCase: (typeof bundleCases)[number]): Promise<Readonly<{
    moduleIds: readonly string[];
    nodeReach: readonly string[];
}>> {
    const moduleGraph = new Map<string, readonly string[]>();
    await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
            alias: [
                {
                    find: /^@happier-dev\/protocol$/u,
                    replacement: protocolRoot,
                },
                {
                    find: '@happier-dev/protocol/plugins/manifest',
                    replacement: protocolManifest,
                },
                {
                    find: '@happier-dev/protocol/plugins/actions/json-schema-validation',
                    replacement: protocolJsonSchemaValidation,
                },
                ...sourceAliases.map(([find, replacement]) => ({
                    find,
                    replacement: resolve(import.meta.dirname, replacement),
                })),
            ],
        },
        plugins: [{
            name: 'plugin-sdk-publication-realm-entry',
            resolveId(id) {
                return id === 'virtual:plugin-sdk-publication-realm-entry' ? `\0${id}` : null;
            },
            load(id) {
                if (id !== '\0virtual:plugin-sdk-publication-realm-entry') return null;
                return bundleCase.source.replace('ENTRY', JSON.stringify(bundleCase.entry));
            },
            generateBundle() {
                for (const id of this.getModuleIds()) {
                    moduleGraph.set(id, this.getModuleInfo(id)?.importedIds ?? []);
                }
            },
        }],
        build: {
            minify: false,
            target: 'es2022',
            write: false,
            rollupOptions: {
                external: (id) => id.startsWith('node:'),
                input: 'virtual:plugin-sdk-publication-realm-entry',
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    inlineDynamicImports: true,
                },
            },
        },
    });
    const entry = '\0virtual:plugin-sdk-publication-realm-entry';
    const queue: ReadonlyArray<Readonly<{ id: string; path: readonly string[] }>> = [{
        id: entry,
        path: [entry],
    }];
    const pending = [...queue];
    const visited = new Set<string>();
    const reach: string[] = [];
    while (pending.length > 0) {
        const current = pending.shift();
        if (!current || visited.has(current.id)) continue;
        visited.add(current.id);
        for (const importedId of moduleGraph.get(current.id) ?? []) {
            const path = [...current.path, importedId];
            if (importedId.startsWith('node:') || importedId.includes('__vite-browser-external')) {
                reach.push(path.join(' -> '));
            } else {
                pending.push({ id: importedId, path });
            }
        }
    }
    return {
        moduleIds: [...moduleGraph.keys()],
        nodeReach: reach,
    };
}

describe('Plugin SDK publication realm closure', () => {
    for (const bundleCase of bundleCases) {
        it(`keeps the ${bundleCase.name} runtime values out of Node-only modules`, async () => {
            const bundle = await bundleNodeReach(bundleCase);
            expect(bundle.nodeReach).toEqual([]);
            if (bundleCase.name === 'Automation result-delivery projection') {
                expect(bundle.moduleIds).toContain(protocolAutomationResultDelivery);
                expect(bundle.moduleIds).not.toContain(protocolRoot);
            }
            if (bundleCase.name === 'Events publication projection') {
                expect(bundle.moduleIds).toContain(protocolAutomationEventSetupResult);
                expect(bundle.moduleIds).not.toContain(protocolRoot);
            }
            if (bundleCase.name === 'Connected Accounts projection') {
                expect(bundle.moduleIds).toContain(protocolClaudeSubscriptionMaterialization);
                expect(bundle.moduleIds).not.toContain(protocolRoot);
            }
            if (bundleCase.name === 'Session input canonical projection') {
                expect(bundle.moduleIds).toContain(protocolSessionSpawnNewInput);
                expect(bundle.moduleIds).not.toContain(protocolRoot);
            }
            if (bundleCase.name === 'Action author projection') {
                expect(bundle.moduleIds).toContain(protocolPluginMachineExecutionOrigin);
                expect(bundle.moduleIds).not.toContain(protocolRoot);
            }
            if (bundleCase.name === 'Settings limits projection') {
                expect(bundle.moduleIds).not.toContain(protocolRoot);
                expect(bundle.moduleIds).not.toContain(protocolAccountScopedCipher);
            }
            if (bundleCase.name === 'Declarative document content-type projection') {
                expect(bundle.moduleIds).not.toContain(protocolDeclarativeDocument);
                expect(bundle.moduleIds).not.toContain(protocolAccountScopedCipher);
            }
        }, 60_000);
    }
});
