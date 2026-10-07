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
const protocolAutomationEvent = resolve(
    import.meta.dirname,
    '../../protocol/src/automations/automationEventV1.ts',
);
const protocolPluginReleaseRef = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/availability/releaseRefV1.ts',
);
const protocolPluginCollections = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/data/collectionsV1.ts',
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
        source: 'export { admitCheckpointedPluginEventObservationV1, admitSessionSocketPluginEventObservationV1, createPluginEventAutomationSetupResultV1JsonSchema, PluginEventAutomationSetupResultV1Schema } from ENTRY;',
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
        configFile: resolve(import.meta.dirname, '../vitest.source.config.ts'),
        logLevel: 'silent',
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
                expect(bundle.moduleIds).toContain(protocolAutomationEvent);
                expect(bundle.moduleIds).toContain(protocolPluginReleaseRef);
                expect(bundle.moduleIds).not.toContain(protocolPluginCollections);
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
