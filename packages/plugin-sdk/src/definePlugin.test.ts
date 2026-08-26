import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    derivePluginDaemonContributionRegistrationRights,
    PLUGIN_CONTRIBUTION_CATALOG_V2,
    VoiceProviderContributionSchema,
} from '@happier-dev/protocol';

import type {
    AgentProviderBindingAdapter,
    AgentRuntimeFactory,
    AgentSessionRunnerFactoryLocatorV1,
} from './agentRuntime/index.js';
import type { BackgroundServiceRunner } from './backgroundServices.js';
import {
    assertDefinePluginCatalogFamilyPolicyClosure,
    DEFINE_PLUGIN_FAMILY_POLICY_V2,
    definePlugin,
    deriveDefinePluginDescriptorOnlyContributionFamilies,
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    projectPluginAccountCollectionDeclaration,
} from './definePlugin.js';
import {
    normalizePluginAccountCollectionMigrationRuntimeProjection as normalizePluginAccountCollectionMigrationRuntimeProjectionFromPublicRoot,
    projectPluginAccountCollectionDeclaration as projectPluginAccountCollectionDeclarationFromPublicRoot,
} from './index.js';
import type {
    DefinePluginInput,
    ComposerControlAuthorInteraction,
    DefinedPluginContributes,
    PluginActionDeclaration,
    PluginAgentDefinition,
    PluginComposerAttachmentDefinition,
    PluginDaemonDatabaseDeclaration,
    PluginProviderDefinition,
} from './definePlugin.js';
import type {
    PluginAccountCollectionMigrationRuntimeProjection as PluginAccountCollectionMigrationRuntimeProjectionFromPublicRoot,
} from './index.js';
import type { ComposerOperationV1 } from './ui/hostApi.js';
import { defineAccountCollection } from './collections.js';
import {
    defineComposerAttachment,
    defineComposerControl,
    defineComposerReference,
    defineComposerRegion,
} from './composer.js';
import type { JsonValue } from './identity.js';
import type { HttpMethod } from './http.js';
import {
    defineProtocolJsonValue,
    defineProtocolLiteral,
    defineProtocolLiteral as defineComposableProtocolLiteral,
    defineProtocolNumber as defineComposableProtocolNumber,
    defineProtocolObject,
    defineProtocolObject as defineComposableProtocolObject,
    defineProtocolString,
    defineProtocolString as defineComposableProtocolString,
    defineProtocolUnion,
} from './protocol/index.js';
import {
    defineContributionPoint,
    defineContributionProtocol,
} from './targetedContributionAuthoring.js';
import type { ContributionSurfaceHandle } from './targetedContributionAuthoring.js';
import * as contributionAuthoring from './targetedContributionAuthoring.js';
import {
    parsePluginManifest,
} from './manifest.js';
import type { PluginManifest } from './manifest.js';
import type {
    AdmittedTargetedOperationExecutionHandle,
    ActionsService,
} from './actions/service.js';
import type {
    PluginApi,
    PluginMcpServerRuntime,
    BackendRuntime,
    ComposerReferenceRuntime,
    HostingProviderRuntime,
} from './activation.js';
import type {
    PluginConnectedAccountRuntime,
} from './services/connectedAccounts.js';
import type {
    TargetedContributionPointRef,
    TargetedContributionSnapshot,
} from './services/targetedContributions.js';
import type { PromptAssetAdapter } from './resources.js';
import type {
    DaemonDatabaseIncumbentQueryFixture,
    DaemonDatabaseMigration,
} from './storage/database.js';
import type { AgentExternalSessionsContribution } from './externalSessions.js';
import type { ManagedProviderRuntime } from './providers/index.js';
import { createPluginRegistrationScope } from './host/registration/index.js';
import type { VoiceProvidersRegistrationApi } from './voice/projections.js';
import type { SpeechProviderRuntime, VoiceSpeechSynthesizeRequest } from './voice/speech.js';

type RegisteredVoiceProviderRuntime = Parameters<VoiceProvidersRegistrationApi['register']>[1];

const executionOnlyFactory: AgentRuntimeFactory = () => Object.freeze({
    executionRuns: Object.freeze({
        open: vi.fn(),
    }),
});

const contributionResultSchema = defineProtocolObject({}, { policy: 'closed' });

const externalSessions: AgentExternalSessionsContribution = {
    resolveSource: async ({ source }) => ({ ok: true, value: { source } }),
    listCandidates: async () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
    resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData: {} },
    }),
    resolveLinkedIdentity: async ({ source, remoteSessionId, linkData }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData },
    }),
    pageTranscript: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    readAfterTranscript: async () => ({ ok: true, value: { outcome: 'already_current' } }),
};

/* @sdk-negative-type-case:src-definePlugin-test-ts-action-input-schema:QWN0aW9uIGlucHV0IHNjaGVtYXMgYWRtaXQgb25seSBKU09OIFNjaGVtYSBkYXRhIG9yIGNvbXBsZXRlIFByb3RvY29sIGNvbXBvc2FibGVzLg:ZGVmaW5lUGx1Z2luKHsgaWQ6ICdleGFtcGxlLmFjdGlvbi1pbnZhbGlkLWlucHV0LXNjaGVtYScsIHZlcnNpb246ICcwLjEuMCcsIGFjdGlvbnM6IHsgaW52YWxpZDogeyB0aXRsZTogJ0ludmFsaWQnLCBleGVjdXRpb246IHsgdGFyZ2V0OiAnZGFlbW9uJyB9LCBzdXJmYWNlczogWydwbHVnaW4nXSwgaW5wdXRTY2hlbWE6IHsgdW5zdXBwb3J0ZWQ6IHRydWUgfSwgYXN5bmMgcnVuKCkgeyByZXR1cm4ge307IH0gfSB9IH0pOw */
void undefined; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-definePlugin-test-ts-action-input-hints:QWN0aW9uIGlucHV0IGhpbnRzIHJldGFpbiB0aGUgUHJvdG9jb2wgQWN0aW9uIGRlY2xhcmF0aW9uIHNoYXBlLg:ZGVmaW5lUGx1Z2luKHsgaWQ6ICdleGFtcGxlLmFjdGlvbi1pbnZhbGlkLWlucHV0LWhpbnRzJywgdmVyc2lvbjogJzAuMS4wJywgYWN0aW9uczogeyBpbnZhbGlkOiB7IHRpdGxlOiAnSW52YWxpZCcsIGV4ZWN1dGlvbjogeyB0YXJnZXQ6ICdkYWVtb24nIH0sIHN1cmZhY2VzOiBbJ3BsdWdpbiddLCBpbnB1dEhpbnRzOiB7IGZpZWxkczogW3sgcGF0aDogJ3ZhbHVlJywgdGl0bGU6ICdWYWx1ZScsIHdpZGdldDogJ3Vuc3VwcG9ydGVkJyB9XSB9LCBhc3luYyBydW4oKSB7IHJldHVybiB7fTsgfSB9IH0gfSk7 */
void undefined; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-definePlugin-test-ts-action-result-schema:QWN0aW9uIHJlc3VsdCBzY2hlbWFzIGFkbWl0IG9ubHkgSlNPTiBTY2hlbWEgZGF0YSBvciBjb21wbGV0ZSBQcm90b2NvbCBjb21wb3NhYmxlcy4:ZGVmaW5lUGx1Z2luKHsgaWQ6ICdleGFtcGxlLmFjdGlvbi1pbnZhbGlkLXJlc3VsdC1zY2hlbWEnLCB2ZXJzaW9uOiAnMC4xLjAnLCBhY3Rpb25zOiB7IGludmFsaWQ6IHsgdGl0bGU6ICdJbnZhbGlkJywgZXhlY3V0aW9uOiB7IHRhcmdldDogJ2RhZW1vbicgfSwgc3VyZmFjZXM6IFsncGx1Z2luJ10sIHJlc3VsdFNjaGVtYTogeyB1bnN1cHBvcnRlZDogdHJ1ZSB9LCBhc3luYyBydW4oKSB7IHJldHVybiB7fTsgfSB9IH0gfSk7 */
void undefined; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-definePlugin-test-ts-action-availability:QWN0aW9uIGF2YWlsYWJpbGl0eSByZXRhaW5zIHRoZSBQcm90b2NvbCBBY3Rpb24gZGVjbGFyYXRpb24gc2hhcGUu:ZGVmaW5lUGx1Z2luKHsgaWQ6ICdleGFtcGxlLmFjdGlvbi1pbnZhbGlkLWF2YWlsYWJpbGl0eScsIHZlcnNpb246ICcwLjEuMCcsIGFjdGlvbnM6IHsgaW52YWxpZDogeyB0aXRsZTogJ0ludmFsaWQnLCBleGVjdXRpb246IHsgdGFyZ2V0OiAnZGFlbW9uJyB9LCBzdXJmYWNlczogWydwbHVnaW4nXSwgYXZhaWxhYmlsaXR5OiB7IGV4cGVyaW1lbnRhbDogdHJ1ZSB9LCBhc3luYyBydW4oKSB7IHJldHVybiB7fTsgfSB9IH0gfSk7 */
void undefined; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-definePlugin-test-ts-provider-canonical-declaration:UHJvdmlkZXIgZGVmaW5lUGx1Z2luIGRlY2xhcmF0aW9ucyBtdXN0IHNhdGlzZnkgdGhlIGNhbm9uaWNhbCBQcm92aWRlckNvbnRyaWJ1dGlvbiBzaGFwZS4=:ZGVmaW5lUGx1Z2luKHsgaWQ6ICdleGFtcGxlLmludmFsaWQtcHJvdmlkZXItc2hhcGUnLCB2ZXJzaW9uOiAnMC4xLjAnLCBwcm92aWRlcnM6IHsgbWFsZm9ybWVkOiB7IGRlY2xhcmF0aW9uOiB7IHY6IDEsIG5hbWU6ICdNYWxmb3JtZWQnLCBraW5kOiAndW5zdXBwb3J0ZWQnLCBlbmRwb2ludFRlbXBsYXRlczogW3sgaWQ6ICdyZXNwb25zZXMnLCBwcm90b2NvbDogJ29wZW5haS1yZXNwb25zZXMnLCBiYXNlVXJsOiAnaHR0cHM6Ly9tb2RlbHMuZXhhbXBsZS5jb20vdjEnLCBjYXBhYmlsaXRpZXM6IHsgc3RyZWFtaW5nOiAnc3VwcG9ydGVkJywgdG9vbFJvdW5kVHJpcHM6ICd1bmtub3duJywgc3RhdGVmdWxSZXNwb25zZXM6ICd1bmtub3duJywgcmVhc29uaW5nQ29udHJvbHM6ICd1bmtub3duJyB9IH1dLCBjYXRhbG9nOiB7IHNvdXJjZTogJ21hbnVhbCcsIG1hbnVhbE1vZGVsUG9saWN5OiAnYWxsb3dlZCcgfSB9IH0gfSB9KTs= */
void undefined; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-definePlugin-test-ts-connected-account-canonical-declaration:Q29ubmVjdGVkIEFjY291bnQgZGVmaW5lUGx1Z2luIGRlY2xhcmF0aW9ucyBtdXN0IHNhdGlzZnkgdGhlIGNhbm9uaWNhbCBkZWNsYXJhdGlvbiB1bmlvbi4=:ZGVmaW5lUGx1Z2luKHsgaWQ6ICdleGFtcGxlLmludmFsaWQtY29ubmVjdGVkLWFjY291bnQtc2hhcGUnLCB2ZXJzaW9uOiAnMC4xLjAnLCBjb25uZWN0ZWRBY2NvdW50RGVzY3JpcHRvcnM6IHsgbWFsZm9ybWVkOiB7IGRlY2xhcmF0aW9uOiB7IHRpdGxlOiAnTWFsZm9ybWVkJywgYXV0aGVudGljYXRpb246IHsgZGVmYXVsdE1vZGVJZDogJ21hbnVhbCcsIG1vZGVzOiBbeyBpZDogJ21hbnVhbCcsIGtpbmQ6ICdtYW51YWwnLCBvdXRjb21lUmVjb25jaWxpYXRpb246ICdub25lJywgZmllbGRzOiBbeyBpZDogJ29yaWdpbicsIHRpdGxlOiAnT3JpZ2luJywgc2VjcmV0OiB0cnVlLCBzZW1hbnRpYzogJ2Nvbm5lY3RlZEFjY291bnRPcmlnaW4nLCByZXF1aXJlZDogdHJ1ZSwgc2NoZW1hOiB7IHR5cGU6ICdzdHJpbmcnLCBtaW5MZW5ndGg6IDEgfSB9XSB9XSB9IH0sIHJ1bnRpbWU6IHt9IGFzIFBsdWdpbkNvbm5lY3RlZEFjY291bnRSdW50aW1lIH0gfSB9KTs= */
void undefined; /* @sdk-negative-type-case-end */

describe('definePlugin', () => {
    it('makes tracked operation authoring impossible for client-targeted Actions', () => {
        type ClientActionDeclaration = Extract<
            PluginActionDeclaration,
            Readonly<{ execution: Readonly<{ target: 'client' }> }>
        >;

        expectTypeOf<ClientActionDeclaration['operation']>().toEqualTypeOf<undefined>();
    });

    it('projects tracked daemon Action metadata for the invocation reporter', () => {
        const plugin = definePlugin({
            id: 'acme.tracked-action',
            version: '1.0.0',
            actions: {
                rebuild: {
                    title: 'Rebuild index',
                    execution: { target: 'daemon' },
                    surfaces: ['plugin'],
                    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
                    async run(_input, context) {
                        context.operation?.update({ phase: 'indexing', label: 'Indexing' });
                        return {};
                    },
                },
            },
        });

        expect(plugin.manifest.contributes.actions).toEqual([
            expect.objectContaining({
                id: 'rebuild',
                execution: { target: 'daemon' },
                operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
            }),
        ]);
    });

    it('projects canonical Provider declarations at the author call', () => {
        const plugin = definePlugin({
            id: 'example.canonical-provider-declaration',
            version: '0.1.0',
            providers: {
                models: {
                    declaration: {
                        v: 1,
                        name: 'Example Models',
                        kind: 'aggregator',
                        endpointTemplates: [{
                            id: 'responses',
                            protocol: 'openai-responses',
                            baseUrl: 'https://models.example.com/v1',
                            capabilities: {
                                streaming: 'supported',
                                toolRoundTrips: 'unknown',
                                statefulResponses: 'unknown',
                                reasoningControls: 'unknown',
                            },
                        }],
                        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
                    },
                },
            },
        });

        expect(plugin.manifest.contributes.providers?.[0]?.id).toBe('models');
    });

    it('uses the canonical Provider declaration projection at the definePlugin boundary', () => {
        const sourceText = readFileSync(new URL('./definePlugin.ts', import.meta.url), 'utf8');

        expect(sourceText).toContain(
            "import type { ProviderContribution } from './providers/projections.js';",
        );
        expect(sourceText).toContain(
            "type PluginProviderDeclaration = DistributiveOmit<ProviderContribution, 'id'>;",
        );
        expect(sourceText).toContain("declaration: Omit<ProviderContribution, 'id' | 'managedRuntime'>");
        expect(sourceText).not.toContain("ContributionRow<'providers'>");
    });

    it('projects canonical Connected Account declarations at the author call', () => {
        const plugin = definePlugin({
            id: 'example.canonical-connected-account-declaration',
            version: '0.1.0',
            connectedAccountDescriptors: {
                account: {
                    declaration: {
                        title: 'Example Account',
                        authentication: {
                            defaultModeId: 'manual',
                            modes: [{
                                id: 'manual',
                                kind: 'manual',
                                outcomeReconciliation: 'none',
                                fields: [{
                                    id: 'token',
                                    title: 'Token',
                                    schema: { type: 'string' },
                                    secret: true,
                                }],
                            }],
                        },
                        metadata: { documentation: 'https://example.com/account' },
                    },
                    runtime: {} as PluginConnectedAccountRuntime,
                },
            },
        });

        expect(plugin.manifest.contributes.connectedAccountDescriptors?.[0]?.metadata)
            .toEqual({ documentation: 'https://example.com/account' });
    });

    it('uses the canonical Connected Account declaration projection at the definePlugin boundary', () => {
        const sourceText = readFileSync(new URL('./definePlugin.ts', import.meta.url), 'utf8');

        expect(sourceText).toContain('PluginConnectedAccountDescriptorContributionV2,');
        expect(sourceText).toContain(
            "DistributiveOmit<PluginConnectedAccountDescriptorContributionV2, 'id'>",
        );
        expect(sourceText).toContain(
            "declaration: Omit<PluginConnectedAccountDescriptorContributionV2, 'id'>;",
        );
        expect(sourceText).not.toContain(
            "NonNullable<NonNullable<PluginManifest['contributes']>['connectedAccountDescriptors']>[number]",
        );
    });

    it('omits undeclared cold defaults while retaining explicit empty declarations', () => {
        const omitted = definePlugin({
            id: 'acme.omitted-cold-defaults',
            version: '1.0.0',
        });
        const explicit = definePlugin({
            id: 'acme.explicit-empty-cold-defaults',
            version: '1.0.0',
            hostAccess: { required: [], optional: [] },
            settings: {},
            mcp: { servers: {} },
        });

        expect(omitted.manifest).not.toHaveProperty('hostAccess');
        expect(omitted.manifest.contributes).toEqual({});
        expect(omitted.manifest.contributes).not.toHaveProperty('hooks');
        expect(omitted.manifest.contributes.hooks).toBeUndefined();
        expect(explicit.manifest.hostAccess).toEqual({ required: [], optional: [] });
        expect(explicit.manifest.contributes).toHaveProperty('settings', []);
        expect(explicit.manifest.contributes.mcp).toEqual({ servers: [] });

        const normalized = parsePluginManifest(omitted.manifest);
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) throw new Error('Expected the sparse cold manifest to normalize');
        expect(normalized.manifest.hostAccess).toEqual({ required: [], optional: [] });
        expect(normalized.manifest.contributes.settings).toEqual([]);
    });

    it('types cold contribution facts as sparse without weakening declared family values', () => {
        type NormalizedContributionFamilies = NonNullable<PluginManifest['contributes']>;

        const sparseColdContributes: DefinedPluginContributes = {};
        expect(sparseColdContributes).toEqual({});
        expectTypeOf<DefinedPluginContributes['hooks']>()
            .toEqualTypeOf<NormalizedContributionFamilies['hooks'] | undefined>();
        expectTypeOf<NonNullable<DefinedPluginContributes['hooks']>>()
            .toEqualTypeOf<NonNullable<NormalizedContributionFamilies['hooks']>>();
    });

    it('emits declared secrets as cold facts for canonical source ingestion', () => {
        const secrets = [{ id: 'api-token' }] as const;

        const plugin = definePlugin({
            id: 'acme.cold-secrets',
            version: '1.0.0',
            secrets,
        });

        expect(plugin.manifest.secrets).toBe(secrets);
    });

    it('projects and executes composable action schemas at the canonical Action boundary', async () => {
        const inputSchema = defineComposableProtocolObject({
            entryId: defineComposableProtocolString({ minLength: 1 }),
        }, { policy: 'additive-open/drop' });
        const resultSchema = defineComposableProtocolObject({
            accepted: defineComposableProtocolLiteral(true),
        }, { policy: 'additive-open/drop' });
        const receivedInputs: unknown[] = [];
        const plugin = definePlugin({
            id: 'acme.composable-action',
            version: '1.0.0',
            actions: {
                inspect: {
                    title: 'Inspect composable input',
                    execution: { target: 'daemon' },
                    surfaces: ['plugin'],
                    inputSchema,
                    resultSchema,
                    async run(input) {
                        expectTypeOf(input.entryId).toEqualTypeOf<string>();
                        receivedInputs.push(input);
                        return {
                            accepted: true as const,
                            ignored: input.entryId,
                        };
                    },
                },
            },
        });

        const action = plugin.manifest.contributes.actions?.[0];
        expect(action?.inputSchema).toEqual(inputSchema.jsonSchema);
        expect(action?.resultSchema).toEqual(resultSchema.jsonSchema);
        expect(action?.inputSchema).not.toHaveProperty('parse');
        expect(action?.resultSchema).not.toHaveProperty('safeParse');

        const register = vi.fn();
        await plugin.activate({ actions: { register } } as never);
        const handler = register.mock.calls[0]?.[1] as ((input: unknown, context: unknown) => Promise<unknown>) | undefined;
        expect(handler).toBeDefined();
        if (!handler) return;

        await expect(handler({ entryId: 'entry', ignored: true }, {})).resolves.toEqual({ accepted: true });
        expect(receivedInputs).toEqual([{ entryId: 'entry' }]);
        await expect(handler({ entryId: '' }, {})).rejects.toMatchObject({
            name: 'ProtocolValidationError',
        });
        expect(receivedInputs).toHaveLength(1);
    });

    it('projects mixed Action targets but root activation registers only daemon handlers', async () => {
        const daemonRun = vi.fn(async () => null);
        const plugin = definePlugin({
            id: 'acme.mixed-action-targets',
            version: '1.0.0',
            actions: {
                daemonAction: {
                    title: 'Daemon action',
                    execution: { target: 'daemon' },
                    surfaces: ['plugin'],
                    run: daemonRun,
                },
                clientAction: {
                    title: 'Client action',
                    execution: {
                        target: 'client',
                        client: {
                            artifactId: 'action-client',
                            modulePath: './runAction',
                            exportName: 'activate',
                        },
                        platforms: ['web'],
                    },
                    surfaces: ['ui'],
                },
            },
        });

        expect(plugin.manifest.contributes.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'daemonAction', execution: { target: 'daemon' } }),
            expect.objectContaining({
                id: 'clientAction',
                execution: expect.objectContaining({ target: 'client' }),
            }),
        ]));

        const register = vi.fn();
        await plugin.activate({ actions: { register } } as never);
        expect(register).toHaveBeenCalledOnce();
        expect(register).toHaveBeenCalledWith('daemonAction', daemonRun);

        expect(() => definePlugin({
            id: 'acme.client-action-inline-handler',
            version: '1.0.0',
            actions: {
                clientAction: {
                    title: 'Client action',
                    execution: {
                        target: 'client',
                        client: {
                            artifactId: 'action-client',
                            modulePath: './runAction',
                            exportName: 'activate',
                        },
                        platforms: ['web'],
                    },
                    surfaces: ['ui'],
                    run: async () => null,
                },
            },
        } as never)).toThrow(/client action.*handler/i);
    });

    it('emits request-policy declarations without adding a HostAccess parser', () => {
        expect(() => definePlugin({
            id: 'acme.request-policy-author',
            version: '1.0.0',
            requestInterceptors: {
                'api-policy': {
                    declaration: {
                        origins: ['https://intercept.example.com'],
                        methods: ['GET'],
                    },
                    interceptor: async (request) => ({ decision: 'continue', request }),
                },
            },
        })).not.toThrow();
    });

    it('closes every catalog family over an adapter or descriptor-only policy', () => {
        const sourcePluginContributionCatalog = PLUGIN_CONTRIBUTION_CATALOG_V2;
        const sourceCatalogFamilies = sourcePluginContributionCatalog
            .map((entry) => entry.manifestKey)
            .sort();
        const policyFamilies = Object.keys(DEFINE_PLUGIN_FAMILY_POLICY_V2).sort();

        expect(() => assertDefinePluginCatalogFamilyPolicyClosure(
            sourcePluginContributionCatalog,
            DEFINE_PLUGIN_FAMILY_POLICY_V2,
        )).not.toThrow();
        expect(policyFamilies).toEqual(sourceCatalogFamilies);
        expect(deriveDefinePluginDescriptorOnlyContributionFamilies(
            sourcePluginContributionCatalog,
        )).toContain('voiceModelPacks');
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2.composerReferences).toMatchObject({
            classification: 'adapter',
            authorKey: 'composer',
        });
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2.openableContentViewers).toMatchObject({
            classification: 'descriptor-only',
            authorKey: 'openableContentViewers',
        });
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2.accountCollections).toMatchObject({
            classification: 'descriptor-only',
            authorKey: 'accountCollections',
        });
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2.transcriptActivities).toMatchObject({
            classification: 'descriptor-only',
            authorKey: 'transcriptActivities',
        });
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2.webhooks).toMatchObject({
            classification: 'descriptor-only',
            authorKey: 'webhooks',
        });
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2.requestInterceptors).toMatchObject({
            classification: 'adapter',
            authorKey: 'requestInterceptors',
            inputShape: 'structured',
        });
        for (const family of ['browserTargets', 'browserActions'] as const) {
            expect(DEFINE_PLUGIN_FAMILY_POLICY_V2[family]).toMatchObject({
                classification: 'descriptor-only',
                authorKey: family,
                inputShape: 'descriptor',
            });
        }
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2['ui.settingsGroups']).toMatchObject({
            classification: 'adapter',
            authorKey: 'ui',
        });
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2['ui.settingsPages']).toMatchObject({
            classification: 'adapter',
            authorKey: 'ui',
        });
        expect(deriveDefinePluginDescriptorOnlyContributionFamilies(
            sourcePluginContributionCatalog,
        )).toContain('openableContentViewers');

        const policyRecord = DEFINE_PLUGIN_FAMILY_POLICY_V2 as unknown as Record<
            string,
            Record<string, unknown>
        >;
        for (const catalogEntry of sourcePluginContributionCatalog) {
            expect(policyRecord[catalogEntry.manifestKey]?.classification).toBe(
                catalogEntry.allowedRuntimeRegistration !== null || catalogEntry.manifestKey.includes('.')
                    ? 'adapter'
                    : 'descriptor-only',
            );
        }
        const withoutRuntimeAdapter = {
            ...DEFINE_PLUGIN_FAMILY_POLICY_V2,
            actions: {
                ...policyRecord.actions,
                classification: 'descriptor-only' as const,
            },
        };
        expect(() => assertDefinePluginCatalogFamilyPolicyClosure(
            sourcePluginContributionCatalog,
            withoutRuntimeAdapter,
        )).toThrow(/missing adapters: actions/iu);

        // `resources` used to be the descriptor-only example here. EU-4b gave
        // its dynamic arm a runtime producer, so it is now a genuine adapter
        // family; `commands` is the current runtime-free family.
        const withDescriptorAdapter = {
            ...DEFINE_PLUGIN_FAMILY_POLICY_V2,
            commands: {
                ...policyRecord.commands,
                classification: 'adapter' as const,
            },
        };
        expect(() => assertDefinePluginCatalogFamilyPolicyClosure(
            sourcePluginContributionCatalog,
            withDescriptorAdapter,
        )).toThrow(/extra adapters: commands/iu);

        const withoutNestedAdapter = {
            ...DEFINE_PLUGIN_FAMILY_POLICY_V2,
            'settings.fields': {
                ...policyRecord['settings.fields'],
                classification: 'descriptor-only' as const,
            },
        };
        expect(() => assertDefinePluginCatalogFamilyPolicyClosure(
            sourcePluginContributionCatalog,
            withoutNestedAdapter,
        )).toThrow(/missing adapters: settings\.fields/iu);

        const futureRuntimeCatalog = [
            ...sourcePluginContributionCatalog,
            {
                ...sourcePluginContributionCatalog[0]!,
                manifestKey: 'future.runtime',
                allowedRuntimeRegistration: 'futureRuntime',
            },
        ];
        const futureRuntimeHiddenWithoutAdapter = {
            ...DEFINE_PLUGIN_FAMILY_POLICY_V2,
            'future.runtime': {
                classification: 'blocked' as const,
                authorKey: 'futureRuntime',
            },
        };
        expect(() => assertDefinePluginCatalogFamilyPolicyClosure(
            futureRuntimeCatalog,
            futureRuntimeHiddenWithoutAdapter,
        )).toThrow(/missing adapters: future\.runtime/iu);

        const futureDescriptorCatalog = [
            ...sourcePluginContributionCatalog,
            {
                ...sourcePluginContributionCatalog[0]!,
                manifestKey: 'futureDescriptor',
                allowedRuntimeRegistration: null,
            },
        ];
        expect(DEFINE_PLUGIN_FAMILY_POLICY_V2).toMatchObject({
            providers: {
                classification: 'adapter',
                authorKey: 'providers',
            },
            voiceProviders: {
                classification: 'adapter',
                authorKey: 'voiceProviders',
            },
            composerReferences: {
                classification: 'adapter',
                authorKey: 'composer',
            },
            voiceModelPacks: { classification: 'descriptor-only' },
            openableContentViewers: { classification: 'descriptor-only' },
            accountCollections: { classification: 'descriptor-only' },
        });
    });

    it('projects simple UI surfaces through the one UI adapter while retaining advanced explicit forms', () => {
        const plugin = definePlugin({
            id: 'com.acme.surface-projection',
            version: '1.0.0',
            ui: {
                surfaces: [
                    {
                        id: 'home',
                        placement: 'appPage',
                        title: 'Home',
                        renderer: {
                            kind: 'reactNative',
                            requiredHostMethods: ['context', 'executeAction'],
                        },
                    },
                    {
                        id: 'settings',
                        placement: 'settingsPage',
                        group: { kind: 'host', id: 'general' },
                        title: 'Settings',
                        renderer: {
                            kind: 'hostedWeb',
                            requiredHostMethods: ['context'],
                        },
                    },
                    {
                        id: 'session-details',
                        placement: 'detailsTab',
                        target: { kind: 'session' },
                        title: 'Session details',
                        renderer: {
                            kind: 'declarative',
                            root: { kind: 'text', text: 'Details' },
                        },
                    },
                ],
                // Raw declarations stay available for shared renderers,
                // fallback chains, and deliberately non-default artifact ids.
                renderers: [
                    {
                        id: 'advanced-main',
                        kind: 'hostedWeb',
                        source: { kind: 'artifact', artifact: 'custom-artifact' },
                    },
                    {
                        id: 'advanced-fallback',
                        kind: 'declarative',
                        root: { kind: 'text', text: 'Fallback' },
                    },
                ],
                views: [{
                    id: 'advanced-view',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'advanced-main',
                    fallbackRenderers: ['advanced-fallback'],
                }],
            },
        });

        expect(plugin.manifest.contributes.ui).toMatchObject({
            views: [
                {
                    id: 'advanced-view',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'advanced-main',
                    fallbackRenderers: ['advanced-fallback'],
                },
                {
                    id: 'home',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'home-renderer',
                    title: 'Home',
                },
                {
                    id: 'session-details',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'session-details-renderer',
                    title: 'Session details',
                },
            ],
            renderers: [
                {
                    id: 'advanced-main',
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: 'custom-artifact' },
                },
                {
                    id: 'advanced-fallback',
                    kind: 'declarative',
                },
                {
                    id: 'home-renderer',
                    kind: 'reactNative',
                    artifact: 'home-renderer',
                    requiredHostMethods: ['context', 'executeAction'],
                },
                {
                    id: 'settings-renderer',
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: 'settings-renderer' },
                    requiredHostMethods: ['context'],
                },
                {
                    id: 'session-details-renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Details' },
                },
            ],
            settingsPages: [{
                id: 'settings',
                group: { kind: 'host', id: 'general' },
                title: 'Settings',
                renderer: 'settings-renderer',
            }],
        });
    });

    it('requires explicit detailed target facts for non-app high-level UI placements', () => {
        const untypedDefinePlugin = definePlugin as (input: unknown) => unknown;

        expect(() => untypedDefinePlugin({
            id: 'com.acme.missing-session-target',
            version: '1.0.0',
            ui: {
                surfaces: [{
                    id: 'details',
                    placement: 'detailsTab',
                    renderer: { kind: 'declarative', root: { kind: 'text', text: 'Details' } },
                }],
            },
        })).toThrow('ui.surfaces details requires an explicit target');
    });

    it('emits raw browser target and action facts through the canonical Action identity', () => {
        expectTypeOf<DefinePluginInput>().toHaveProperty('browserTargets');
        expectTypeOf<DefinePluginInput>().toHaveProperty('browserActions');

        const plugin = definePlugin({
            id: 'acme.browser-author',
            version: '1.0.0',
            actions: {
                open: {
                    title: 'Open preview',
                    execution: { target: 'daemon' },
                    surfaces: ['plugin'],
                    run: async () => null,
                },
            },
            browserTargets: {
                docs: {
                    title: 'Docs',
                    url: 'https://example.com/docs',
                    profile: 'session',
                },
            },
            browserActions: {
                'open-docs': {
                    title: 'Open docs',
                    action: 'open',
                    target: 'docs',
                    placement: 'toolbar',
                },
            },
        });

        expect(plugin.actionContracts.open).toEqual({
            pluginId: 'acme.browser-author',
            localId: 'open',
        });
        expect(plugin.manifest.contributes.browserTargets).toEqual([{
            id: 'docs',
            title: 'Docs',
            url: 'https://example.com/docs',
            profile: 'session',
        }]);
        expect(plugin.manifest.contributes.browserActions).toEqual([{
            id: 'open-docs',
            title: 'Open docs',
            action: 'open',
            target: 'docs',
            placement: 'toolbar',
        }]);
    });

    it('compiles declared request-policy handlers into the canonical activation registration', async () => {
        const interceptor = vi.fn(async (request: Readonly<{
            url: string;
            method: HttpMethod;
            headers: Readonly<Record<string, string>>;
        }>) => ({
            decision: 'continue' as const,
            request,
        }));
        const plugin = definePlugin({
            id: 'acme.request-policy-author',
            version: '1.0.0',
            requestInterceptors: {
                'api-policy': {
                    declaration: {
                        origins: ['https://api.example.test'],
                        methods: ['GET'],
                        priority: 10,
                    },
                    interceptor,
                },
            },
        });
        const register = vi.fn();

        await plugin.activate({
            interceptors: { register },
        } as unknown as PluginApi);

        expect(plugin.manifest.contributes.requestInterceptors).toEqual([{
            id: 'api-policy',
            origins: ['https://api.example.test'],
            methods: ['GET'],
            priority: 10,
        }]);
        expect(register).toHaveBeenCalledWith('api-policy', interceptor);
    });

    it('rejects an Account Collection map key that disagrees with its single declaration id', () => {
        const tasks = defineAccountCollection({
            id: 'tasks',
            schemaVersion: 1,
            schema: defineComposableProtocolObject({
                id: defineComposableProtocolString(),
            }, { policy: 'closed' }),
            identityFields: [],
            serverReadable: ['id'],
            indexes: [{ id: 'by-id', fields: [{ field: 'id', direction: 'asc' }] }],
        });
        const malformedInput = {
            id: 'example.account-collection-id-mismatch',
            version: '0.1.0',
            accountCollections: { projects: tasks },
        };

        expect(() => definePlugin(
            malformedInput as unknown as Parameters<typeof definePlugin>[0],
        )).toThrow(/Account Collection.*projects.*tasks/iu);
    });

    it('accepts a trusted accessor-backed Account Collection id while preserving key identity', () => {
        const tasks = defineAccountCollection({
            id: 'tasks',
            schemaVersion: 1,
            schema: defineComposableProtocolObject({
                id: defineComposableProtocolString(),
            }, { policy: 'closed' }),
            identityFields: [],
            serverReadable: ['id'],
            indexes: [{ id: 'by-id', fields: [{ field: 'id', direction: 'asc' }] }],
        });
        const accessorBackedTasks = { ...tasks };
        let idReads = 0;
        Object.defineProperty(accessorBackedTasks, 'id', {
            enumerable: true,
            get() {
                idReads += 1;
                return 'tasks';
            },
        });

        const plugin = definePlugin({
            id: 'example.trusted-accessor-account-collection',
            version: '0.1.0',
            accountCollections: { tasks: accessorBackedTasks },
        });

        expect(idReads).toBeGreaterThan(0);
        expect(plugin.manifest.contributes.accountCollections).toMatchObject([{ id: 'tasks' }]);
    });

    it('binds only the exact declared Voice runtime through voiceProviders.register', async () => {
        const declaration = VoiceProviderContributionSchema.parse({
            id: 'speech',
            title: 'Speech',
            kind: 'speech',
            roles: ['conversation_tts'],
            platforms: ['web'],
            settings: {
                schemaVersion: 2,
                fields: [{
                    id: 'voiceName',
                    title: 'Voice',
                    schema: { type: 'string', minLength: 1, maxLength: 256 },
                    default: 'voice-a',
                    presentation: { control: 'text' },
                }],
            },
        });
        const { id: _id, ...authoredDeclaration } = declaration;
        const runtime = Object.freeze({
            kind: 'speech',
            synthesize: async (request: VoiceSpeechSynthesizeRequest) => ({
                requestId: request.requestId,
                bytes: new Uint8Array(),
                mimeType: 'audio/wav' as const,
            }),
        } satisfies SpeechProviderRuntime);
        const defineVoicePlugin = (input: Readonly<Record<string, unknown>> = {}) => definePlugin({
            id: 'example.voice-provider',
            version: '0.1.0',
            voiceProviders: {
                speech: { declaration: authoredDeclaration, runtime },
            },
            ...input,
        } as unknown as Parameters<typeof definePlugin>[0]);
        const createScope = (plugin: ReturnType<typeof definePlugin>) => createPluginRegistrationScope({
            pluginId: plugin.manifest.id,
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(
                plugin.manifest.contributes as Readonly<Record<string, unknown>>,
            ),
        });

        const plugin = defineVoicePlugin();
        const scope = createScope(plugin);
        await plugin.activate(scope.api);
        expect(scope.commit()).toEqual([{
            family: 'voiceProviders',
            localId: 'speech',
            value: {
                kind: 'speech',
                synthesize: expect.any(Function),
            },
        }]);

        const missing = defineVoicePlugin({
            voiceProviders: { speech: { declaration: authoredDeclaration } },
        });
        const missingScope = createScope(missing);
        await expect(missing.activate(missingScope.api)).rejects.toThrow(/invalid Voice provider runtime/iu);
        expect(missingScope.registrations()).toEqual([]);

        const extra = definePlugin({
            id: 'example.extra-voice-runtime',
            version: '0.1.0',
            setup(api: PluginApi) {
                api.voiceProviders.register('speech', runtime);
            },
        });
        const extraScope = createScope(extra);
        await expect(extra.activate(extraScope.api)).rejects.toThrow(
            /undeclared contribution 'voiceProviders\/speech'/iu,
        );
        expect(extraScope.registrations()).toEqual([]);

        const wrongId = defineVoicePlugin({
            setup(api: PluginApi) {
                api.voiceProviders.register('other', runtime);
            },
        });
        const wrongIdScope = createScope(wrongId);
        await expect(wrongId.activate(wrongIdScope.api)).rejects.toThrow(
            /undeclared contribution 'voiceProviders\/other'/iu,
        );
        expect(wrongIdScope.registrations()).toEqual([]);

        const duplicate = defineVoicePlugin({
            setup(api: PluginApi) {
                api.voiceProviders.register('speech', runtime);
            },
        });
        const duplicateScope = createScope(duplicate);
        await expect(duplicate.activate(duplicateScope.api)).rejects.toThrow(
            /duplicate contribution 'voiceProviders\/speech'/iu,
        );
        expect(duplicateScope.registrations()).toEqual([]);

        const wrongKind = defineVoicePlugin({
            voiceProviders: {
                speech: {
                    declaration: authoredDeclaration,
                    runtime: Object.freeze({ kind: 'conversation' }) as RegisteredVoiceProviderRuntime,
                },
            },
        });
        const wrongKindScope = createScope(wrongKind);
        await wrongKind.activate(wrongKindScope.api);
        expect(() => wrongKindScope.commit()).toThrow(
            /registered an invalid 'voiceProviders\/speech' runtime/iu,
        );
        expect(wrongKindScope.registrations()).toEqual([]);
    });

    it('emits the approved staged-media display and host-preview facts', () => {
        const untypedDefinePlugin = definePlugin as (input: unknown) => unknown;
        const value = defineComposableProtocolObject({}, { policy: 'additive-open/preserve' });

        for (const presentation of [
            {
                display: { kind: 'media', media: 'image' },
                preview: { kind: 'host', presentation: 'image' },
            },
            {
                display: { kind: 'media', media: 'video' },
                preview: { kind: 'host', presentation: 'video' },
            },
        ]) {
            expect(() => untypedDefinePlugin({
                id: 'example.composer-custody-held',
                version: '0.1.0',
                composer: {
                    attachments: {
                        issue: {
                            title: 'Issue',
                            icon: 'error',
                            cardinality: 'many',
                            value,
                            ...presentation,
                        },
                    },
                },
            })).not.toThrow();
        }

    });

    it('types declarative composerApply effects as canonical Composer operations', () => {
        type ComposerApplyEffect = Extract<
            Extract<ComposerControlAuthorInteraction, Readonly<{ kind: 'choices' }>>['options'][number]['effect'],
            Readonly<{ kind: 'composerApply' }>
        >;

        expectTypeOf<ComposerApplyEffect['operations']>()
            .toEqualTypeOf<readonly ComposerOperationV1[]>();
    });

    it('projects every r1.0 Composer family from the grouped author namespace', async () => {
        /* @sdk-negative-type-case:src-definePlugin-test-ts-composer-icon:Q29tcG9zZXIgYXV0aG9yIGljb25zIG11c3QgbWF0Y2ggdGhlIHJ1bnRpbWUgbWFuaWZlc3QgdG9rZW4gc2V0Lg:ZGVmaW5lQ29tcG9zZXJDb250cm9sKHsgbGFiZWw6ICdJbnZhbGlkIGljb24gY29udHJhY3QnLCBpY29uOiAnZWRpdCcsIGludGVyYWN0aW9uOiB7IGtpbmQ6ICdhY3Rpb24nLCBhY3Rpb246ICdleGFtcGxlLmFjdGlvbicgfSB9KTs */
        void undefined; /* @sdk-negative-type-case-end */
        const search = vi.fn(async () => [{
            id: 'issue:42',
            label: 'Issue 42',
        }]);
        const issueDraft = defineComposableProtocolObject({
            issueId: defineComposableProtocolString(),
        }, { policy: 'closed' });
        const preparedIssue = defineComposableProtocolString();
        const preparedAttachment = defineComposerAttachment({
            title: 'Prepared issue',
            icon: 'error',
            cardinality: 'one',
            value: issueDraft,
            preparedValue: preparedIssue,
            preview: {
                kind: 'surface',
                renderer: 'warning-surface',
                presentation: 'popover',
            },
            runtime: {
                prepareForSend: vi.fn(async () => ({ attachments: [] })),
            },
        });
        type ExpectedPreparedAttachment = PluginComposerAttachmentDefinition<
            Readonly<{ issueId: string }>,
            string
        >;
        expectTypeOf<typeof preparedAttachment>().toMatchTypeOf<ExpectedPreparedAttachment>();
        expectTypeOf<ExpectedPreparedAttachment>().toMatchTypeOf<typeof preparedAttachment>();
        const plugin = definePlugin({
            id: 'example.composer-reference-provider',
            version: '0.1.0',
            ui: {
                renderers: [{
                    id: 'warning-surface',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Warning' },
                }],
            },
            composer: {
                references: {
                    issues: defineComposerReference({
                        title: 'Issues',
                        icon: 'error',
                        search,
                        resolve: async (candidateId) => {
                            expectTypeOf(candidateId).toEqualTypeOf<string>();
                            return {
                                id: candidateId,
                                label: 'Issue 42',
                                context: 'Current incident context.',
                            };
                        },
                    }),
                },
                attachments: {
                    issue: defineComposerAttachment({
                        title: 'Issue',
                        icon: 'error',
                        cardinality: 'many',
                        value: issueDraft,
                        picker: 'warning-surface',
                        display: {
                            kind: 'surface',
                            renderer: 'warning-surface',
                            sizing: 'compact',
                        },
                    }),
                    'prepared-issue': preparedAttachment,
                },
                controls: {
                    'issue-control': defineComposerControl({
                        label: 'Issue',
                        icon: 'error',
                        interaction: {
                            kind: 'attachmentPicker',
                            attachment: 'issue',
                            presentation: 'popover',
                            layout: 'content',
                        },
                    }),
                    'surface-control': defineComposerControl({
                        label: 'Surface issue',
                        icon: 'error',
                        compactRenderer: 'warning-surface',
                        overflow: {
                            label: 'More issue actions',
                            icon: 'more',
                        },
                        interaction: {
                            kind: 'surface',
                            renderer: 'warning-surface',
                            presentation: 'popover',
                            layout: 'content',
                        },
                    }),
                },
                regions: {
                    warning: defineComposerRegion({
                        placement: 'beforeComposer',
                        renderer: 'warning-surface',
                    }),
                },
            },
        });

        expect(plugin.manifest.contributes.composerReferences).toEqual([{
            id: 'issues',
            title: 'Issues',
            icon: 'error',
        }]);
        expect(plugin.manifest.contributes.composerAttachments).toEqual([{
            id: 'issue',
            title: 'Issue',
            icon: 'error',
            cardinality: 'many',
            valueSchema: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: { issueId: { type: 'string' } },
                required: ['issueId'],
                additionalProperties: false,
            },
            picker: { renderer: 'warning-surface' },
            display: {
                kind: 'surface',
                renderer: { renderer: 'warning-surface' },
                sizing: 'compact',
            },
        }, {
            id: 'prepared-issue',
            title: 'Prepared issue',
            icon: 'error',
            cardinality: 'one',
            valueSchema: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: { issueId: { type: 'string' } },
                required: ['issueId'],
                additionalProperties: false,
            },
            preparedValueSchema: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'string',
            },
            preview: {
                kind: 'surface',
                renderer: { renderer: 'warning-surface' },
                presentation: 'popover',
            },
            runtime: { prepareForSend: true },
        }]);
        expect(plugin.manifest.contributes.composerControls).toEqual([{
            id: 'issue-control',
            label: 'Issue',
            icon: 'error',
            interaction: {
                kind: 'attachmentPicker',
                attachment: 'issue',
                presentation: 'popover',
                layout: 'content',
            },
        }, {
            id: 'surface-control',
            label: 'Surface issue',
            icon: 'error',
            compactRenderer: { renderer: 'warning-surface' },
            overflow: {
                label: 'More issue actions',
                icon: 'more',
            },
            interaction: {
                kind: 'surface',
                renderer: { renderer: 'warning-surface' },
                presentation: 'popover',
                layout: 'content',
            },
        }]);
        expect(plugin.manifest.contributes.composerRegions).toEqual([{
            id: 'warning',
            placement: 'beforeComposer',
            renderer: { renderer: 'warning-surface' },
        }]);
        const emitted = JSON.parse(JSON.stringify(plugin.manifest));
        expect(emitted.contributes.composerReferences).toEqual(plugin.manifest.contributes.composerReferences);
        expect(emitted.contributes.composerAttachments).toEqual(plugin.manifest.contributes.composerAttachments);
        expect(emitted.contributes.composerControls).toEqual(plugin.manifest.contributes.composerControls);
        expect(emitted.contributes.composerRegions).toEqual(plugin.manifest.contributes.composerRegions);

        const scope = createPluginRegistrationScope({
            pluginId: plugin.manifest.id,
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(
                plugin.manifest.contributes as Readonly<Record<string, unknown>>,
            ),
        });
        await plugin.activate(scope.api);
        expect(scope.commit()).toEqual([
            expect.objectContaining({
                family: 'composerReferences',
                localId: 'issues',
            }),
            expect.objectContaining({
                family: 'composerAttachments',
                localId: 'prepared-issue',
                value: { prepareForSend: expect.any(Function) },
            }),
        ]);
    });

    it('projects daemon-database callbacks exactly with their descriptor identities without a PluginApi registration', async () => {
        const declaration = {
            id: 'index',
            migrations: [{ version: 1, id: 'create-index' }],
            incumbentQueryFixtureId: 'current-index-readable',
        } as const satisfies PluginDaemonDatabaseDeclaration;
        const migration: DaemonDatabaseMigration = {
            version: 1,
            id: 'create-index',
            up: async () => undefined,
        };
        const incumbentQueryFixture: DaemonDatabaseIncumbentQueryFixture = {
            id: 'current-index-readable',
            run: async () => undefined,
        };
        const plugin = definePlugin({
            id: 'example.daemon-database',
            version: '0.1.0',
            daemonDatabases: {
                index: {
                    migrations: [migration],
                    incumbentQueryFixture,
                },
            },
        });
        const scope = createPluginRegistrationScope({
            pluginId: plugin.manifest.id,
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(
                plugin.manifest.contributes as Readonly<Record<string, unknown>>,
            ),
        });

        expect(plugin.manifest.contributes.daemonDatabases).toEqual([declaration]);
        expect(plugin.daemonDatabases).toEqual({
            index: {
                migrations: [migration],
                incumbentQueryFixture,
            },
        });

        await plugin.activate(scope.api);
        expect(scope.commit()).toEqual([]);
    });

    it('projects Collection migration identities statically and retains only their exact target callbacks', async () => {
        const migrateV1ToV2 = (value: Readonly<Record<string, JsonValue>>) => ({
            id: String(value.id),
            status: 'open',
            title: String(value.title),
        }) as const;
        const migrateV2ToV3 = (value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            id: String(value.id),
            status: 'open',
            title: String(value.title),
        }) as Readonly<Record<string, JsonValue>>;
        const migrations = [
            {
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
                migrate: migrateV1ToV2,
            },
            {
                id: 'upgrade-v2-to-v3',
                fromSchemaVersion: 2,
                toSchemaVersion: 3,
                migrate: migrateV2ToV3,
            },
        ] as const;
        const tasks = defineAccountCollection({
            id: 'tasks',
            schemaVersion: 3,
            readableSchemaVersions: [1, 2],
            schema: defineComposableProtocolObject({
                id: defineComposableProtocolString(),
                status: defineComposableProtocolString(),
                title: defineComposableProtocolString(),
            }, { policy: 'closed' }),
            identityFields: [],
            serverReadable: ['status', 'title'],
            indexes: [{ id: 'by-status', fields: [{ field: 'status', direction: 'asc' }] }],
            migrations,
        });
        const plugin = definePlugin({
            id: 'example.collection-migration',
            version: '0.1.0',
            accountCollections: { tasks },
        });
        const declarations = plugin.manifest.contributes.accountCollections ?? [];
        const staticTasksDeclaration = projectPluginAccountCollectionDeclaration('tasks', tasks);
        const scope = createPluginRegistrationScope({
            pluginId: plugin.manifest.id,
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(
                plugin.manifest.contributes as Readonly<Record<string, unknown>>,
            ),
        });

        expect(declarations).toEqual([{
            id: 'tasks',
            schemaVersion: 3,
            readableSchemaVersions: [1, 2],
            migrations: [
                { id: 'upgrade-v1-to-v2', fromSchemaVersion: 1, toSchemaVersion: 2 },
                { id: 'upgrade-v2-to-v3', fromSchemaVersion: 2, toSchemaVersion: 3 },
            ],
            schema: expect.any(Object),
            identityFields: [],
            serverReadable: ['status', 'title'],
            indexes: [{ id: 'by-status', fields: [{ field: 'status', direction: 'asc' }] }],
        }]);
        expect(declarations[0]).not.toHaveProperty('migrations.0.migrate');
        expect(staticTasksDeclaration).toMatchObject({
            id: 'tasks',
            migrations: [
                { id: 'upgrade-v1-to-v2', fromSchemaVersion: 1, toSchemaVersion: 2 },
                { id: 'upgrade-v2-to-v3', fromSchemaVersion: 2, toSchemaVersion: 3 },
            ],
        });
        expect(staticTasksDeclaration).not.toHaveProperty('migrations.0.migrate');
        expect(readFileSync(new URL('./index.public.ts', import.meta.url), 'utf8')).toContain(
            "export { projectPluginAccountCollectionDeclaration } from './definePlugin.js';",
        );
        expect(projectPluginAccountCollectionDeclarationFromPublicRoot)
            .toBe(projectPluginAccountCollectionDeclaration);
        expect(plugin.collectionMigrations).toEqual({ tasks: migrations });
        const publicRootProjection: PluginAccountCollectionMigrationRuntimeProjectionFromPublicRoot =
            plugin.collectionMigrations;
        expect(normalizePluginAccountCollectionMigrationRuntimeProjectionFromPublicRoot)
            .toBe(normalizePluginAccountCollectionMigrationRuntimeProjection);
        expect(normalizePluginAccountCollectionMigrationRuntimeProjectionFromPublicRoot(
            publicRootProjection,
            declarations,
        )).toEqual(plugin.collectionMigrations);
        expect(normalizePluginAccountCollectionMigrationRuntimeProjection(
            plugin.collectionMigrations,
            declarations,
        )).toEqual(plugin.collectionMigrations);
        expect(() => normalizePluginAccountCollectionMigrationRuntimeProjection({
            tasks: [migrations[0]],
        }, declarations)).toThrow(/migrations do not match/i);
        expect(() => normalizePluginAccountCollectionMigrationRuntimeProjection({
            tasks: [migrations[1], migrations[0]],
        }, declarations)).toThrow(/migration 0 does not match/i);
        expect(() => normalizePluginAccountCollectionMigrationRuntimeProjection({
            tasks: [migrations[0], migrations[1], migrations[0]],
        }, declarations)).toThrow(/migrations do not match/i);
        expect(() => normalizePluginAccountCollectionMigrationRuntimeProjection({
            tasks: [{ ...migrations[0], id: 'changed' }, migrations[1]],
        }, declarations)).toThrow(/migration 0 does not match/i);
        expect(() => normalizePluginAccountCollectionMigrationRuntimeProjection({
            tasks: migrations,
            extra: [],
        }, declarations)).toThrow(/match the manifest declarations exactly/i);

        await plugin.activate(scope.api);
        expect(scope.commit()).toEqual([]);
    });

    it('projects a one-file action into the canonical manifest and named activation ABI', async () => {
        const run = vi.fn(async () => ({ text: 'ok' }));
        const plugin = definePlugin({
            id: 'example.one-file',
            version: '0.1.0',
            description: 'One-file fixture',
            actions: {
                inspect: {
                    title: 'Inspect',
                    execution: { target: 'daemon' },
                    run,
                },
            },
        });

        expect(plugin.manifest).toMatchObject({
            schemaVersion: 2,
            id: 'example.one-file',
            version: '0.1.0',
            description: 'One-file fixture',
            contributes: {
                actions: [{
                    id: 'inspect',
                    title: 'Inspect',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    surfaces: ['cli'],
                    placementBindings: ['commandPalette'],
                    dangerLevel: 'safe',
                }],
            },
        });
        expect(plugin.manifest).not.toHaveProperty('engines');

        const register = vi.fn();
        await plugin.activate({
            actions: { register },
        } as never);

        expect(register).toHaveBeenCalledOnce();
        expect(register).toHaveBeenCalledWith('inspect', run);
    });

    it('does not manufacture a human placement for a plugin-only Action declaration', () => {
        const plugin = definePlugin({
            id: 'example.plugin-only-action',
            version: '0.1.0',
            actions: {
                configure: {
                    title: 'Configure provider',
                    execution: { target: 'daemon' },
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    run: async () => undefined,
                },
            },
        });

        const [configure] = plugin.manifest.contributes.actions ?? [];
        expect(configure).toMatchObject({
            id: 'configure',
            scopes: ['settings'],
            surfaces: ['plugin'],
        });
        expect(configure).not.toHaveProperty('placementBindings');
    });

    it('does not manufacture a human placement for a programmatic Action reachable from several programmatic surfaces', () => {
        // `voice` is discovery, not a human destination, so a plugin-and-voice
        // Action is exactly as programmatic as a plugin-only one. Manufacturing
        // `commandPalette` here would put a bounded programmatic read in the
        // user's command palette, and the placement vocabulary has no empty
        // value an author could use to take it back.
        const plugin = definePlugin({
            id: 'example.programmatic-action',
            version: '0.1.0',
            actions: {
                list: {
                    title: 'Read the current list window',
                    execution: { target: 'daemon' },
                    surfaces: ['plugin', 'voice'],
                    run: async () => undefined,
                },
            },
        });

        const [list] = plugin.manifest.contributes.actions ?? [];
        expect(list).toMatchObject({ id: 'list', surfaces: ['plugin', 'voice'] });
        expect(list).not.toHaveProperty('placementBindings');
    });

    it('defaults a UI Action to the approved command-palette placement', () => {
        const plugin = definePlugin({
            id: 'example.ui-action',
            version: '0.1.0',
            actions: {
                inspect: {
                    title: 'Inspect',
                    execution: { target: 'daemon' },
                    surfaces: ['ui'],
                    run: async () => undefined,
                },
            },
        });

        expect(plugin.manifest.contributes.actions).toEqual([
            expect.objectContaining({
                id: 'inspect',
                surfaces: ['ui'],
                placementBindings: ['commandPalette'],
            }),
        ]);
    });

    it('projects one Action through every declared semantic Composer and message placement in order', () => {
        const plugin = definePlugin({
            id: 'example.composer-action',
            version: '0.1.0',
            actions: {
                'open-review': {
                    title: 'Open review',
                    execution: { target: 'daemon' },
                    icon: 'sparkles',
                    scopes: ['session', 'message'],
                    surfaces: ['ui'],
                    placementBindings: [
                        'composer.primary',
                        'composer.more',
                        'composer.slash',
                        'message.menu',
                    ],
                    priority: -20,
                    run: async () => undefined,
                },
            },
        });

        expect(plugin.manifest.contributes.actions).toEqual([expect.objectContaining({
            id: 'open-review',
            icon: 'sparkles',
            placementBindings: [
                'composer.primary',
                'composer.more',
                'composer.slash',
                'message.menu',
            ],
            priority: -20,
        })]);
    });

    it('projects transcript activities and webhooks through their catalog-owned descriptor families', () => {
        const plugin = definePlugin({
            id: 'example.catalog-descriptor-families',
            version: '0.1.0',
            hostAccess: {
                required: [{
                    id: 'account-storage',
                    capability: 'storage.account',
                    reason: 'Persist Account-scoped Resource state',
                    scope: { enabled: true },
                }],
                optional: [],
            },
            actions: {
                'receive-github': {
                    title: 'Receive GitHub event',
                    execution: { target: 'daemon' },
                    surfaces: ['plugin'],
                    run: async () => undefined,
                },
            },
            resources: {
                'import-progress': {
                    source: 'dynamic',
                    kind: 'config',
                    contentType: 'application/vnd.happier.transcript-activity+json;v=1',
                    maxBytes: 65_536,
                    scope: 'session',
                    hostAccess: ['account-storage'],
                    runtime: {
                        read: async ({ accountStorage, context, signal }) => {
                            if (signal.aborted || context.kind !== 'session') return new Uint8Array();
                            if (accountStorage === undefined) return new Uint8Array();
                            const entry = await accountStorage.kv.get<string>('status');
                            return new TextEncoder().encode(
                                entry && 'value' in entry && typeof entry.value === 'string'
                                    ? entry.value
                                    : '',
                            );
                        },
                        observe: (_invalidate, { accountStorage, signal }) => {
                            void accountStorage?.kv.get('status', { signal });
                            return { dispose: () => undefined };
                        },
                    },
                },
            },
            transcriptActivities: {
                'import-progress-card': {
                    resourceId: 'import-progress',
                    actions: [],
                },
            },
            webhooks: {
                'github-events': {
                    title: 'GitHub events',
                    verifier: { kind: 'github_hmac_sha256_v1', routing: 'accountEndpoint' },
                    handlerAction: { localId: 'receive-github' },
                },
            },
        });

        expect(plugin.manifest.contributes.transcriptActivities).toEqual([{
            id: 'import-progress-card',
            resourceId: 'import-progress',
            actions: [],
        }]);
        expect(plugin.manifest.contributes.resources).toEqual([{
            id: 'import-progress',
            source: 'dynamic',
            kind: 'config',
            contentType: 'application/vnd.happier.transcript-activity+json;v=1',
            maxBytes: 65_536,
            scope: 'session',
            hostAccess: ['account-storage'],
        }]);
        expect(plugin.manifest.contributes.webhooks).toEqual([{
            id: 'github-events',
            title: 'GitHub events',
            verifier: { kind: 'github_hmac_sha256_v1', routing: 'accountEndpoint' },
            handlerAction: { localId: 'receive-github' },
        }]);
    });

    it('projects an optional packaged PNG brand Resource through the canonical manifest', () => {
        const plugin = definePlugin({
            id: 'example.brand',
            version: '0.1.0',
            brand: { iconResourceId: 'brand-icon' },
            resources: {
                'brand-icon': {
                    kind: 'asset',
                    path: 'assets/brand.png',
                    contentType: 'image/png',
                },
            },
        });

        expect(plugin.manifest.brand).toEqual({ iconResourceId: 'brand-icon' });
        expect(plugin.manifest.contributes.resources).toEqual([{
            id: 'brand-icon',
            kind: 'asset',
            path: 'assets/brand.png',
            contentType: 'image/png',
        }]);

    });

    it('binds only declared managed Provider runtimes through the canonical registration transaction', async () => {
        const providerDeclaration = {
            v: 1 as const,
            name: 'Acme Models',
            kind: 'aggregator' as const,
            endpointTemplates: [{
                id: 'responses',
                protocol: 'openai-responses' as const,
                baseUrl: 'https://models.example.com/v1',
                capabilities: {
                    streaming: 'supported' as const,
                    toolRoundTrips: 'unknown' as const,
                    statefulResponses: 'unknown' as const,
                    reasoningControls: 'unknown' as const,
                },
            }],
            catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
        };
        const runtime = Object.freeze({
            start: vi.fn<ManagedProviderRuntime['start']>(),
        });
        const createScope = (plugin: ReturnType<typeof definePlugin>) => createPluginRegistrationScope({
            pluginId: plugin.manifest.id,
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(
                plugin.manifest.contributes as Readonly<Record<string, unknown>>,
            ),
        });

        const managed = definePlugin({
            id: 'example.managed-provider',
            version: '0.1.0',
            providers: {
                gateway: {
                    declaration: {
                        ...providerDeclaration,
                        managedRuntime: {
                            kind: 'managed',
                            endpointTemplateIds: ['responses'],
                        },
                    },
                    runtime,
                },
            },
        } as unknown as Parameters<typeof definePlugin>[0]);
        const managedScope = createScope(managed);
        await managed.activate(managedScope.api);
        const [managedRegistration] = managedScope.commit();
        expect(managedRegistration).toMatchObject({
            family: 'providers',
            localId: 'gateway',
            value: { managedRuntime: { start: expect.any(Function) } },
        });
        if (managedRegistration?.family !== 'providers') {
            throw new Error('Expected a managed Provider registration');
        }
        const managedProviderRuntime = managedRegistration.value.managedRuntime;
        if (!managedProviderRuntime) {
            throw new Error('Expected a managed Provider runtime field');
        }
        expect(managedProviderRuntime).not.toBe(runtime);
        expect(managedProviderRuntime.start).not.toBe(runtime.start);
        await managedProviderRuntime.start({} as never, {} as never);
        expect(runtime.start).toHaveBeenCalledOnce();

        const descriptorOnly = definePlugin({
            id: 'example.descriptor-provider',
            version: '0.1.0',
            providers: {
                catalog: { declaration: providerDeclaration },
            },
        } as unknown as Parameters<typeof definePlugin>[0]);
        const descriptorOnlyScope = createScope(descriptorOnly);
        await descriptorOnly.activate(descriptorOnlyScope.api);
        expect(descriptorOnlyScope.commit()).toEqual([]);

        const missing = definePlugin({
            id: 'example.missing-provider-runtime',
            version: '0.1.0',
            providers: {
                gateway: {
                    declaration: {
                        ...providerDeclaration,
                        managedRuntime: {
                            kind: 'managed',
                            endpointTemplateIds: ['responses'],
                        },
                    },
                },
            },
        } as unknown as Parameters<typeof definePlugin>[0]);
        const missingScope = createScope(missing);
        await missing.activate(missingScope.api);
        expect(() => missingScope.commit()).toThrow(/missing registration 'providers\/gateway'/iu);

        const extra = definePlugin({
            id: 'example.extra-provider-runtime',
            version: '0.1.0',
            providers: {
                catalog: { declaration: providerDeclaration, runtime },
            },
        } as unknown as Parameters<typeof definePlugin>[0]);
        const extraScope = createScope(extra);
        await expect(extra.activate(extraScope.api)).rejects.toThrow(
            /undeclared contribution 'providers\/catalog'/iu,
        );
        expect(extraScope.registrations()).toEqual([]);

        const wrongId = definePlugin({
            id: 'example.wrong-provider-runtime',
            version: '0.1.0',
            providers: {
                gateway: {
                    declaration: {
                        ...providerDeclaration,
                        managedRuntime: {
                            kind: 'managed',
                            endpointTemplateIds: ['responses'],
                        },
                    },
                    runtime,
                },
            },
            setup(api: PluginApi) {
                api.providers.register('other', runtime);
            },
        } as unknown as Parameters<typeof definePlugin>[0]);
        const wrongIdScope = createScope(wrongId);
        await expect(wrongId.activate(wrongIdScope.api)).rejects.toThrow(
            /undeclared contribution 'providers\/other'/iu,
        );
        expect(wrongIdScope.registrations()).toEqual([]);

        const duplicate = definePlugin({
            id: 'example.duplicate-provider-runtime',
            version: '0.1.0',
            providers: {
                gateway: {
                    declaration: {
                        ...providerDeclaration,
                        managedRuntime: {
                            kind: 'managed',
                            endpointTemplateIds: ['responses'],
                        },
                    },
                    runtime,
                },
            },
            setup(api: PluginApi) {
                api.providers.register('gateway', runtime);
            },
        } as unknown as Parameters<typeof definePlugin>[0]);
        const duplicateScope = createScope(duplicate);
        await expect(duplicate.activate(duplicateScope.api)).rejects.toThrow(
            /duplicate managed Provider runtime for Provider 'gateway'/iu,
        );
        expect(duplicateScope.registrations()).toEqual([]);
    });

    it('keeps execution-only Agents one-file and requires an explicit leaf for Session Agents', () => {
        const executionOnly = definePlugin({
            id: 'example.execution-only',
            version: '0.1.0',
            agents: {
                reviewer: {
                    declaration: {
                        title: 'Reviewer',
                        runtime: { kind: 'custom' },
                        primary: 'executionRuns',
                        capabilities: {
                            executionRuns: {
                                open: ['create'],
                                checkpoint: false,
                                stop: true,
                            },
                        },
                    },
                    factory: executionOnlyFactory,
                },
            },
        });

        expect(executionOnly.manifest.contributes.agents?.[0]).toMatchObject({
            id: 'reviewer',
            primary: 'executionRuns',
        });

        expect(() => definePlugin({
            id: 'example.session-agent',
            version: '0.1.0',
            agents: {
                session: {
                    declaration: {
                        title: 'Session Agent',
                        runtime: { kind: 'custom' },
                        primary: 'sessions',
                        capabilities: {
                            sessions: {
                                open: ['create'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                    },
                    factory: executionOnlyFactory,
                },
            },
        })).toThrow(/distinct named runner leaf/i);
    });

    it('requires and registers the exact External Sessions facet declared by an Agent', async () => {
        const declaration = {
            title: 'External Agent',
            runtime: { kind: 'custom' as const },
            primary: 'executionRuns' as const,
            capabilities: {
                executionRuns: { open: ['create' as const], checkpoint: false, stop: true },
                surfaces: ['externalSessions' as const],
            },
            surfaces: {
                externalSession: {
                    sources: [{
                        sourceKind: 'fixture',
                        schema: {
                            fields: [
                                { name: 'kind', kind: 'literal' as const, value: 'fixture' },
                                { name: 'agentDir', kind: 'string' as const, nullish: true },
                            ],
                        },
                        key: { segments: [
                            { kind: 'literal' as const, value: 'fixture' },
                            { kind: 'field' as const, field: 'agentDir' },
                        ] },
                        instances: [
                            { kind: 'default' as const, constants: {} },
                            {
                                kind: 'agentSettingOverride' as const,
                                settingId: 'fixtureAgentDir',
                                field: 'agentDir',
                                normalization: 'configuredPath' as const,
                                constants: {},
                            },
                        ],
                    }],
                },
            },
        };
        expect(() => definePlugin({
            id: 'example.agent-external-missing',
            version: '0.1.0',
            agents: {
                assistant: { declaration, factory: executionOnlyFactory },
            },
        })).toThrow(/External Sessions.*required|requires.*External Sessions/iu);

        const plugin = definePlugin({
            id: 'example.agent-external',
            version: '0.1.0',
            agents: {
                assistant: { declaration, factory: executionOnlyFactory, externalSessions },
            },
        });
        const register = vi.fn();
        const registerExternalSessions = vi.fn();
        await plugin.activate({
            agents: { register, registerExternalSessions },
        } as never);
        expect(register).toHaveBeenCalledWith('assistant', executionOnlyFactory, undefined);
        expect(registerExternalSessions).toHaveBeenCalledWith('assistant', externalSessions);
    });

    it('keeps Agent executable-binding construction local to definePlugin', () => {
        expect(() => definePlugin({
            id: 'example.invalid-cold-agent-before-runtime-binding',
            version: '0.1.0',
            agents: {
                invalid: {
                    declaration: {
                        title: '',
                        runtime: { kind: 'custom' },
                        primary: 'sessions',
                        capabilities: {
                            sessions: {
                                open: ['create'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                    },
                },
            },
        } as unknown as Parameters<typeof definePlugin>[0])).toThrow(
            /requires a runtime factory/iu,
        );
    });

    it.each([
        ['raw contributes', { contributes: {} }, /manual named ABI|raw contributes/iu],
        ['unknown field', { surprise: true }, /unknown.*surprise|surprise.*unknown/iu],
    ] as const)('fails closed for cast/runtime %s input', (_label, extra, expected) => {
        expect(() => definePlugin({
            id: 'example.invalid-runtime-key',
            version: '0.1.0',
            ...extra,
        } as unknown as Parameters<typeof definePlugin>[0])).toThrow(expected);
    });

    it.each([
        ['descriptor family array', { commands: [] }, /'commands'/u],
        ['descriptor family null', { tools: null }, /'tools'/u],
        ['descriptor family scalar', { resources: 'packaged' }, /'resources'/u],
        ['contribution points scalar', { contributionPoints: 7 }, /'contributionPoints'/u],
        ['targeted contributions array', { contributesTo: [] }, /'contributesTo'/u],
        ['targeted point map scalar', { contributesTo: { 'other.plugin': 'panels' } }, /other\.plugin/u],
        [
            'targeted declaration map scalar',
            { contributesTo: { 'other.plugin': { panels: 'main' } } },
            /other\.plugin\/panels/u,
        ],
    ] as const)(
        'rejects a present-but-malformed %s container instead of projecting an empty family',
        (_label, extra, expected) => {
            const define = () => definePlugin({
                id: 'example.malformed-family-container',
                version: '0.1.0',
                ...extra,
            } as unknown as Parameters<typeof definePlugin>[0]);
            expect(define).toThrow(TypeError);
            expect(define).toThrow(expected);
        },
    );

    it('keeps an omitted family absent and an explicitly empty family declared', () => {
        const omitted = definePlugin({
            id: 'example.omitted-family',
            version: '0.1.0',
        }).manifest.contributes as Readonly<Record<string, unknown>>;
        expect(omitted).not.toHaveProperty('commands');
        expect(omitted).not.toHaveProperty('targetedPluginContributions');

        const declaredEmpty = definePlugin({
            id: 'example.empty-family',
            version: '0.1.0',
            commands: {},
            contributesTo: {},
        }).manifest.contributes as Readonly<Record<string, unknown>>;
        expect(declaredEmpty.commands).toEqual([]);
        expect(declaredEmpty.targetedPluginContributions).toEqual([]);
    });

    it('ignores process-local symbol fields while retaining enumerable input validation', () => {
        const input = {
            id: 'example.symbol-sidecar',
            version: '0.1.0',
        };
        Object.defineProperty(input, Symbol('author-sidecar'), {
            enumerable: true,
            value: Object.freeze({ source: 'author-only' }),
        });

        expect(definePlugin(input).manifest.id).toBe('example.symbol-sidecar');
    });

    it('registers the same mixed Agent factory with its explicit runner locator', async () => {
        const mixedFactory: AgentRuntimeFactory = () => Object.freeze({
            sessions: Object.freeze({ open: vi.fn() }),
            executionRuns: Object.freeze({ open: vi.fn() }),
        });
        const plugin = definePlugin({
            id: 'example.mixed-agent',
            version: '0.1.0',
            agents: {
                mixed: {
                    declaration: {
                        title: 'Mixed Agent',
                        runtime: { kind: 'custom' },
                        primary: 'sessions',
                        capabilities: {
                            sessions: {
                                open: ['create'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                            executionRuns: {
                                open: ['create'],
                                checkpoint: false,
                                stop: true,
                            },
                        },
                    },
                    factory: mixedFactory,
                    sessionRunnerFactory: {
                        module: './agent/runtime/factory.js',
                        export: 'mixedFactory',
                        runtimeApiVersion: 1,
                    },
                },
            },
        });
        const register = vi.fn();

        await plugin.activate({ agents: { register } } as never);

        expect(register).toHaveBeenCalledWith('mixed', mixedFactory, {
            sessionRunnerFactory: {
                module: './agent/runtime/factory.js',
                export: 'mixedFactory',
                runtimeApiVersion: 1,
            },
        });
    });

    it('routes every authored Agent registration capability through definePlugin', async () => {
        const completeFactory: AgentRuntimeFactory = () => Object.freeze({
            sessions: Object.freeze({ open: vi.fn() }),
            executionRuns: Object.freeze({ open: vi.fn() }),
        });
        const providerBinding = Object.freeze({
            v: 1,
            adapterVersion: 1,
            prepare() {
                return Object.freeze({
                    v: 1 as const,
                    materialization: 'spawnEnv' as const,
                });
            },
            async materialize() {
                return Object.freeze({
                    v: 1 as const,
                    kind: 'spawnEnv' as const,
                    env: Object.freeze([]),
                });
            },
        }) satisfies AgentProviderBindingAdapter;
        const daemonSpawnHooks = Object.freeze({
            augmentEnv: () => ({ EXAMPLE_AGENT_SPAWN: 'enabled' }),
        });
        const providerCliAttach = Object.freeze({
            resolveTarget: () => ({ ok: false as const, reason: 'fixture target is unavailable' }),
            createArgs: () => [],
            buildHealthUrl: () => null,
        });
        const preflightSessionControls = Object.freeze({
            models: Object.freeze({
                command: Object.freeze({
                    toolId: 'example-cli',
                    args: Object.freeze(['models']),
                }),
            }),
        });
        const terminalPromptSubmitVerification = Object.freeze({
            shouldVerifyAfterSubmit: (promptText: string) => promptText.trim().length > 0,
            verifyAfterSubmit: ({ promptText, screenText }: Readonly<{
                promptText: string;
                screenText: string;
            }>) => screenText.includes(promptText),
        });
        const connectedAccountLaunch = Object.freeze({
            requestAuthUses: Object.freeze([Object.freeze({
                purpose: 'model_upstream',
                materialization: Object.freeze({
                    kind: 'httpHeaders' as const,
                    origin: 'https://api.example.test',
                    headerNames: Object.freeze(['authorization']),
                }),
            })]),
            stateSharingDescriptor: Object.freeze({
                providerSupportStatus: 'unsupported' as const,
                config: Object.freeze({
                    supported: false,
                    modes: Object.freeze(['isolated']),
                    entries: Object.freeze([]),
                    unavailableReason: 'not_implemented' as const,
                }),
                state: Object.freeze({
                    supported: false,
                    modes: Object.freeze(['isolated']),
                    entries: Object.freeze([]),
                    symlinkUnavailableDegradePolicy: 'degrade_to_isolated' as const,
                    unavailableReason: 'not_implemented' as const,
                }),
                authIsolation: Object.freeze({
                    mode: 'process_env' as const,
                    secretEntries: Object.freeze(['EXAMPLE_API_KEY']),
                }),
            }),
        });
        const plugin = definePlugin({
            id: 'example.complete-agent-registration',
            version: '0.1.0',
            agents: {
                assistant: {
                    declaration: {
                        title: 'Complete Agent registration',
                        runtime: { kind: 'custom' },
                        primary: 'sessions',
                        capabilities: {
                            sessions: {
                                open: ['create'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                    },
                    factory: completeFactory,
                    providerBinding,
                    sessionRunnerFactory: {
                        module: './agent/runtime/factory.js',
                        export: 'mixedFactory',
                        runtimeApiVersion: 1,
                    },
                    daemonSpawnHooks,
                    providerCliAttach,
                    preflightSessionControls,
                    terminalPromptSubmitVerification,
                    connectedAccountLaunch,
                },
            },
        } as unknown as Parameters<typeof definePlugin>[0]);
        const register = vi.fn();

        await plugin.activate({ agents: { register } } as never);

        expect(register).toHaveBeenCalledWith('assistant', completeFactory, {
            providerBinding,
            sessionRunnerFactory: {
                module: './agent/runtime/factory.js',
                export: 'mixedFactory',
                runtimeApiVersion: 1,
            },
            daemonSpawnHooks,
            providerCliAttach,
            preflightSessionControls,
            terminalPromptSubmitVerification,
            connectedAccountLaunch,
        });
    });

    it('preserves the canonical provider-binding adapter in generated Agent registration', async () => {
        const providerBinding = Object.freeze({
            v: 1,
            adapterVersion: 1,
            prepare() {
                return Object.freeze({
                    v: 1 as const,
                    materialization: 'spawnEnv' as const,
                });
            },
            async materialize() {
                return Object.freeze({
                    v: 1 as const,
                    kind: 'spawnEnv' as const,
                    env: Object.freeze([]),
                });
            },
        }) satisfies AgentProviderBindingAdapter;
        const plugin = definePlugin({
            id: 'example.provider-bound-agent',
            version: '0.1.0',
            agents: {
                execution: {
                    declaration: {
                        title: 'Provider-bound Agent',
                        runtime: { kind: 'custom' },
                        primary: 'executionRuns',
                        capabilities: {
                            executionRuns: {
                                open: ['create'],
                                checkpoint: false,
                                stop: true,
                            },
                        },
                    },
                    factory: executionOnlyFactory,
                    providerBinding,
                },
            },
        });
        const register = vi.fn();

        await plugin.activate({ agents: { register } } as never);

        expect(register).toHaveBeenCalledWith('execution', executionOnlyFactory, {
            providerBinding,
        });
    });

    it('does not require a custom runner leaf for host-owned ACP Session Agents', async () => {
        const plugin = definePlugin({
            id: 'example.acp-agent',
            version: '0.1.0',
            agents: {
                acp: {
                    declaration: {
                        title: 'ACP Agent',
                        runtime: {
                            kind: 'acp',
                            transport: { kind: 'tcp', host: '127.0.0.1', port: 4321 },
                        },
                        primary: 'sessions',
                        capabilities: {
                            sessions: {
                                open: ['create'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                    },
                },
            },
        });

        await expect(plugin.activate({ agents: {} } as never)).resolves.toBeUndefined();
    });

    it('runs generated registrations before setup and returns setup cleanup unchanged', async () => {
        const order: string[] = [];
        const cleanup = vi.fn();
        const plugin = definePlugin({
            id: 'example.setup',
            version: '0.1.0',
            actions: {
                action: {
                    title: 'Action',
                    execution: { target: 'daemon' },
                    run: async () => undefined,
                },
            },
            setup(api) {
                order.push('setup');
                expect(api).toBeDefined();
                return cleanup;
            },
        });
        const register = vi.fn(() => order.push('register'));

        const result = await plugin.activate({ actions: { register } } as never);

        expect(order).toEqual(['register', 'setup']);
        expect(result).toBe(cleanup);
    });

    it('projects and registers an adapter-bearing prompt asset under its row local id', async () => {
        const adapter = {
            descriptor: {
                id: 'acme.skill',
                providerId: 'acme',
                title: 'Acme skills',
                description: 'Acme SKILL.md bundles.',
                libraryKind: 'bundle',
                supportsScope: { user: true, project: true },
                supportsFiles: true,
                formatId: 'skill_md_v1',
                defaultRoots: [],
                capabilities: {},
            },
            async discover() { throw new Error('not invoked'); },
            async read() { throw new Error('not invoked'); },
            async writeDoc() { throw new Error('not invoked'); },
            async writeBundle() { throw new Error('not invoked'); },
            async delete() { throw new Error('not invoked'); },
        } satisfies PromptAssetAdapter;
        const plugin = definePlugin({
            id: 'example.prompt-assets',
            version: '0.1.0',
            resources: {
                'skill-context': {
                    kind: 'skill',
                    path: 'skills/context/SKILL.md',
                    contentType: 'text/markdown',
                },
            },
            agents: {
                'acme-agent': {
                    declaration: {
                        title: 'Acme Agent',
                        runtime: { kind: 'custom' },
                        primary: 'executionRuns',
                        capabilities: {
                            executionRuns: { open: ['create'], checkpoint: false, stop: true },
                        },
                    },
                    factory: executionOnlyFactory,
                },
            },
            promptAssets: {
                'external-skills': {
                    declaration: {
                        kind: 'context',
                        resource: 'skill-context',
                        target: { kind: 'agent', agent: 'acme-agent' },
                    },
                    adapter,
                },
            },
        });

        expect(plugin.manifest.contributes.promptAssets).toContainEqual({
            id: 'external-skills',
            kind: 'context',
            resource: 'skill-context',
            target: { kind: 'agent', agent: 'acme-agent' },
            adapterDescriptor: adapter.descriptor,
        });
        const registerPromptAssetAdapter = vi.fn();
        await plugin.activate({
            agents: { register: vi.fn() },
            resources: { registerPromptAssetAdapter },
        } as never);
        expect(registerPromptAssetAdapter).toHaveBeenCalledWith('external-skills', adapter);
    });

    it('projects client-only Voice and descriptor-only prompt assets without inventing daemon registrations', async () => {
        const plugin = definePlugin({
            id: 'example.client-only-contributions',
            version: '0.1.0',
            resources: {
                'guide-resource': {
                    source: 'packaged',
                    kind: 'template',
                    path: 'resources/guide.md',
                    contentType: 'text/markdown',
                },
            },
            agents: {
                reviewer: {
                    declaration: {
                        title: 'Reviewer',
                        runtime: { kind: 'custom' },
                        primary: 'executionRuns',
                        capabilities: {
                            executionRuns: { open: ['create'], checkpoint: false, stop: true },
                        },
                    },
                    factory: executionOnlyFactory,
                },
            },
            promptAssets: {
                'guide-prompt': {
                    kind: 'context',
                    resource: 'guide-resource',
                    target: { kind: 'agent', agent: 'reviewer' },
                },
            },
            voiceProviders: {
                browser: {
                    declaration: {
                        title: 'Browser conversation',
                        kind: 'conversation',
                        roles: ['realtime_conversation'],
                        platforms: ['web'],
                        capabilities: {
                            turn: { cancelResponse: false, bargeIn: false },
                            tools: { effectCalls: 'none' },
                        },
                        client: {
                            artifactId: 'browser-voice',
                            modulePath: './voiceProvider',
                            exportName: 'activate',
                        },
                    },
                },
            },
        });

        expect(plugin.manifest.contributes.promptAssets).toEqual([{
            id: 'guide-prompt',
            kind: 'context',
            resource: 'guide-resource',
            target: { kind: 'agent', agent: 'reviewer' },
        }]);
        expect(plugin.manifest.contributes.voiceProviders).toEqual([expect.objectContaining({
            id: 'browser',
            kind: 'conversation',
            client: {
                artifactId: 'browser-voice',
                modulePath: './voiceProvider',
                exportName: 'activate',
            },
        })]);

        const registerPromptAssetAdapter = vi.fn();
        const registerVoiceProvider = vi.fn();
        await plugin.activate({
            agents: { register: vi.fn() },
            resources: { registerPromptAssetAdapter },
            voiceProviders: { register: registerVoiceProvider },
        } as never);
        expect(registerPromptAssetAdapter).not.toHaveBeenCalled();
        expect(registerVoiceProvider).not.toHaveBeenCalled();
    });

    it('projects and registers background services by their declared local id', async () => {
        const runner: BackgroundServiceRunner = async () => undefined;
        const plugin = definePlugin({
            id: 'example.background',
            version: '0.1.0',
            backgroundServices: [{
                declaration: { id: 'indexer', title: 'Workspace indexer' },
                runner,
            }],
        });

        expect(plugin.manifest.contributes.backgroundServices).toEqual([
            { id: 'indexer', title: 'Workspace indexer' },
        ]);
        const register = vi.fn();
        await plugin.activate({ backgroundServices: { register } } as never);
        expect(register).toHaveBeenCalledWith('indexer', runner);
    });

    it('projects generated hook and event rows while registering only executable leaves', async () => {
        const beforeHook = vi.fn(async () => ({ status: 'continue' as const, input: {} }));
        const subscription = vi.fn(async () => undefined);
        const plugin = definePlugin({
            id: 'example.interception-events',
            version: '0.1.0',
            hooks: {
                'augment-action': {
                    declaration: {
                        on: 'action.execute.before',
                        hookApiVersion: 1,
                        category: 'augmentation',
                        scope: 'tool',
                        executionKind: 'augment',
                    },
                    handler: beforeHook,
                },
            },
            events: {
                'item-changed': {
                    declaration: { kind: 'event', title: 'Item changed' },
                },
                'watch-item': {
                    declaration: {
                        kind: 'subscription',
                        target: {
                            kind: 'plugin',
                            event: { pluginId: 'example.source', localId: 'item-changed' },
                        },
                    },
                    handler: subscription,
                },
            },
        });

        expect(plugin.manifest.contributes.hooks).toContainEqual({
            id: 'augment-action',
            on: 'action.execute.before',
            hookApiVersion: 1,
            category: 'augmentation',
            scope: 'tool',
            executionKind: 'augment',
        });
        expect(plugin.manifest.contributes.events).toEqual([
            { id: 'item-changed', kind: 'event', title: 'Item changed' },
            {
                id: 'watch-item',
                kind: 'subscription',
                target: {
                    kind: 'plugin',
                    event: { pluginId: 'example.source', localId: 'item-changed' },
                },
            },
        ]);
        const registerHook = vi.fn();
        const registerEvent = vi.fn();
        await plugin.activate({
            hooks: { register: registerHook },
            events: { register: registerEvent },
        } as never);
        expect(registerHook).toHaveBeenCalledWith('augment-action', beforeHook);
        expect(registerEvent).toHaveBeenCalledOnce();
        expect(registerEvent).toHaveBeenCalledWith('watch-item', subscription);
    });

    it('keeps static MCP rows registration-free and registers dynamic/discovery runtimes', async () => {
        const runtime = { dispose: vi.fn() } as unknown as PluginMcpServerRuntime;
        const discover = vi.fn(async () => ({ items: [] }));
        const plugin = definePlugin({
            id: 'example.mcp',
            version: '0.1.0',
            hostAccess: {
                required: [{
                    id: 'mcp-capabilities',
                    capability: 'mcp',
                    reason: 'Use the declared MCP capabilities',
                    scope: {
                        serverRefs: ['docs', 'dynamic'],
                        discoverySourceRefs: ['catalog'],
                        operations: ['listTools', 'callTools', 'discover'],
                    },
                }],
                optional: [],
            },
            mcp: {
                servers: {
                    docs: {
                        declaration: {
                            kind: 'static',
                            title: 'Docs',
                            transport: {
                                kind: 'http',
                                url: 'https://example.com/mcp',
                            },
                        },
                    },
                    dynamic: {
                        declaration: { kind: 'dynamic', title: 'Dynamic' },
                        runtime,
                    },
                },
                discoverySources: {
                    catalog: {
                        declaration: { title: 'Catalog' },
                        discover,
                    },
                },
            },
        });

        expect(plugin.manifest.contributes.mcp).toMatchObject({
            servers: [
                { id: 'docs', kind: 'static', title: 'Docs' },
                { id: 'dynamic', kind: 'dynamic', title: 'Dynamic' },
            ],
            discoverySources: [{ id: 'catalog', title: 'Catalog' }],
        });
        expect(plugin.manifest.hostAccess?.required).toContainEqual({
            id: 'mcp-capabilities',
            capability: 'mcp',
            reason: 'Use the declared MCP capabilities',
            scope: {
                serverRefs: ['docs', 'dynamic'],
                discoverySourceRefs: ['catalog'],
                operations: ['listTools', 'callTools', 'discover'],
            },
        });
        const registerServer = vi.fn();
        const registerDiscoverySource = vi.fn();
        await plugin.activate({
            mcp: { registerServer, registerDiscoverySource },
        } as never);
        expect(registerServer).toHaveBeenCalledOnce();
        expect(registerServer).toHaveBeenCalledWith('dynamic', runtime);
        expect(registerDiscoverySource).toHaveBeenCalledWith('catalog', discover);
    });

    it('projects matrix-derived descriptor and settled runtime families without parallel declarations', async () => {
        const sendNotification = vi.fn(async (request: { deliveryId: string; channelId: string }) => ({
            deliveryId: request.deliveryId,
            channelId: request.channelId,
            status: 'accepted' as const,
            evidence: 'provider' as const,
        }));
        // Runtime behavior belongs to the connected-account owner; this fixture only proves identity-preserving registration.
        const accountRuntime = Object.freeze({}) as unknown as PluginConnectedAccountRuntime;
        const scmHostingRuntime = Object.freeze({}) as unknown as HostingProviderRuntime;
        const scmBackendRuntime = Object.freeze({}) as unknown as BackendRuntime;
        const plugin = definePlugin({
            id: 'example.matrix',
            version: '0.1.0',
            actions: {
                inspect: {
                    title: 'Inspect',
                    execution: { target: 'daemon' },
                    run: async () => undefined,
                },
            },
            commands: {
                'inspect-command': {
                    title: 'Inspect',
                    path: ['inspect'],
                    action: 'inspect',
                },
            },
            resources: {
                readme: {
                    kind: 'asset',
                    path: 'README.md',
                    contentType: 'text/markdown',
                },
            },
            managedDependencies: {
                formatter: {
                    title: 'Formatter',
                    sources: [{ kind: 'system', executableNames: ['formatter'] }],
                },
            },
            systemTools: {
                git: { title: 'Git', executableNames: ['git'] },
            },
            ui: {
                renderers: [{
                    id: 'summary-renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Summary' },
                }],
                views: [{
                    id: 'summary-view',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'summary-renderer',
                    title: 'Summary',
                }],
                translations: [],
            },
            openableContentViewers: {
                'markdown-viewer': {
                    destination: 'summary-view',
                    contentClasses: ['text'],
                    mimeTypes: ['text/markdown'],
                    extensions: ['.md'],
                },
            },
            notificationChannels: {
                local: {
                    declaration: { title: 'Local', kind: 'plugin' },
                    sender: sendNotification,
                },
            },
            connectedAccountDescriptors: {
                account: {
                    declaration: {
                        title: 'Account',
                        authentication: {
                            defaultModeId: 'manual',
                            modes: [{
                                id: 'manual',
                                kind: 'manual',
                                outcomeReconciliation: 'none',
                                fields: [{
                                    id: 'token',
                                    title: 'Token',
                                    schema: { type: 'string' },
                                    secret: true,
                                }],
                            }],
                        },
                    },
                    runtime: accountRuntime,
                },
            },
            scmHostingProviders: {
                forge: {
                    declaration: {
                        title: 'Forge',
                        kind: 'fixture',
                        capabilities: ['detect'],
                    },
                    runtime: scmHostingRuntime,
                },
            },
            scmBackends: {
                vcs: {
                    declaration: {
                        title: 'VCS',
                        kind: 'fixture',
                        capabilities: ['detect'],
                    },
                    runtime: scmBackendRuntime,
                },
            },
        });

        expect(plugin.manifest.contributes.commands ?? []).toContainEqual({
            id: 'inspect-command',
            title: 'Inspect',
            path: ['inspect'],
            action: 'inspect',
        });
        expect(plugin.manifest.contributes.resources ?? []).toContainEqual({
            id: 'readme',
            kind: 'asset',
            path: 'README.md',
            contentType: 'text/markdown',
        });
        expect(plugin.manifest.contributes.ui?.views ?? []).toHaveLength(1);
        expect(plugin.manifest.contributes.openableContentViewers ?? []).toContainEqual({
            id: 'markdown-viewer',
            destination: 'summary-view',
            contentClasses: ['text'],
            mimeTypes: ['text/markdown'],
            extensions: ['.md'],
        });
        expect(plugin.manifest.contributes.notificationChannels?.[0]?.id).toBe('local');
        expect(plugin.manifest.contributes.connectedAccountDescriptors?.[0]?.id).toBe('account');

        const registerChannel = vi.fn();
        const registerConnectedAccount = vi.fn();
        const registerHostingProvider = vi.fn();
        const registerBackend = vi.fn();
        await plugin.activate({
            actions: { register: vi.fn() },
            notifications: { registerChannel },
            connectedAccounts: { register: registerConnectedAccount },
            scm: { registerHostingProvider, registerBackend },
        } as never);
        expect(registerChannel).toHaveBeenCalledWith('local', sendNotification);
        expect(registerConnectedAccount).toHaveBeenCalledWith('account', accountRuntime);
        expect(registerHostingProvider).toHaveBeenCalledWith('forge', scmHostingRuntime);
        expect(registerBackend).toHaveBeenCalledWith('vcs', scmBackendRuntime);
    });

    it('rejects runtime material on descriptor-only rows and missing conditional runtimes at compile time', () => {
        if (false) {
            const providerDeclaration = {
                v: 1 as const,
                name: 'Acme Models',
                kind: 'aggregator' as const,
                endpointTemplates: [{
                    id: 'responses',
                    protocol: 'openai-responses' as const,
                    baseUrl: 'https://models.example.com/v1',
                    capabilities: {
                        streaming: 'supported' as const,
                        toolRoundTrips: 'unknown' as const,
                        statefulResponses: 'unknown' as const,
                        reasoningControls: 'unknown' as const,
                    },
                }],
                catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
            };
            const managedProviderRuntime: ManagedProviderRuntime = { start: vi.fn() };
            /* @sdk-negative-type-case:src-definePlugin-test-ts-1:VGhlIGV4cG9ydGVkIFByb3ZpZGVyIGRlZmluaXRpb24gdHlwZSBpdHNlbGYgcmVxdWlyZXMgdGhlIG1hbmFnZWQgZmFjZXQu:Y29uc3QgaW52YWxpZEV4cGxpY2l0UHJvdmlkZXJEZWZpbml0aW9uOiBQbHVnaW5Qcm92aWRlckRlZmluaXRpb24gPSB7CmRlY2xhcmF0aW9uOiBwcm92aWRlckRlY2xhcmF0aW9uLAogICAgICAgICAgICAgICAgcnVudGltZTogbWFuYWdlZFByb3ZpZGVyUnVudGltZSwKICAgICAgICAgICAgfTs */
const invalidExplicitProviderDefinition = undefined as never; /* @sdk-negative-type-case-end */
            void invalidExplicitProviderDefinition;
            definePlugin({
                id: 'example.provider-authoring-types',
                version: '0.1.0',
                providers: {
                    descriptor: { declaration: providerDeclaration },
                    managed: {
                        declaration: {
                            ...providerDeclaration,
                            managedRuntime: {
                                kind: 'managed' as const,
                                endpointTemplateIds: ['responses'],
                            },
                        },
                        runtime: managedProviderRuntime,
                    },
                },
            });
            /* @sdk-negative-type-case:src-definePlugin-test-ts-2:QSBtYW5hZ2VkIFByb3ZpZGVyIGRlY2xhcmF0aW9uIHJlcXVpcmVzIGl0cyBleGFjdCBydW50aW1lLg:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgICAgIGlkOiAnZXhhbXBsZS5wcm92aWRlci1hdXRob3JpbmctbWlzc2luZy1ydW50aW1lJywKICAgICAgICAgICAgICAgIHZlcnNpb246ICcwLjEuMCcsCiAgICAgICAgICAgICAgICBwcm92aWRlcnM6IHsKbWFuYWdlZDogewogICAgICAgICAgICAgICAgICAgICAgICBkZWNsYXJhdGlvbjogewogICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4ucHJvdmlkZXJEZWNsYXJhdGlvbiwKICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1hbmFnZWRSdW50aW1lOiB7CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogJ21hbmFnZWQnIGFzIGNvbnN0LAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVuZHBvaW50VGVtcGxhdGVJZHM6IFsncmVzcG9uc2VzJ10sCiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICB9KTs */
void 0; /* @sdk-negative-type-case-end */
            /* @sdk-negative-type-case:src-definePlugin-test-ts-3:QSBkZXNjcmlwdG9yLW9ubHkgUHJvdmlkZXIgY2Fubm90IHJlZ2lzdGVyIGEgcnVudGltZS4:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgICAgIGlkOiAnZXhhbXBsZS5wcm92aWRlci1hdXRob3JpbmctZXh0cmEtcnVudGltZScsCiAgICAgICAgICAgICAgICB2ZXJzaW9uOiAnMC4xLjAnLAogICAgICAgICAgICAgICAgcHJvdmlkZXJzOiB7CmRlc2NyaXB0b3I6IHsKICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb246IHByb3ZpZGVyRGVjbGFyYXRpb24sCiAgICAgICAgICAgICAgICAgICAgICAgIHJ1bnRpbWU6IG1hbmFnZWRQcm92aWRlclJ1bnRpbWUsCiAgICAgICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgIH0pOw */
void 0; /* @sdk-negative-type-case-end */
            /* @sdk-negative-type-case:src-definePlugin-test-ts-4:VGhlIG1hbnVhbCBjb2xkLW1hbmlmZXN0IHBhdGggaXMgdGhlIHNlcGFyYXRlIG5hbWVkIEFCSSwgbm90IGEgZGVmaW5lUGx1Z2luIGJ5cGFzcy4:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgICAgIGlkOiAnZXhhbXBsZS5pbnZhbGlkLWF1dGhvcmluZycsCiAgICAgICAgICAgICAgICB2ZXJzaW9uOiAnMC4xLjAnLApjb250cmlidXRlczoge30sCiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IHsKICAgICAgICAgICAgICAgICAgICBpbnZhbGlkOiB7CiAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6ICdhc3NldCcsCiAgICAgICAgICAgICAgICAgICAgICAgIHBhdGg6ICdSRUFETUUubWQnLAogICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50VHlwZTogJ3RleHQvbWFya2Rvd24nLApydW50aW1lOiB7fSwKICAgICAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgIGV2ZW50czogewppbnZhbGlkOiB7CiAgICAgICAgICAgICAgICAgICAgICAgIGRlY2xhcmF0aW9uOiB7CiAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiAnc3Vic2NyaXB0aW9uJywKICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldDogeyBraW5kOiAncGx1Z2luJywgZXZlbnQ6ICdwdWJsaXNoZWQnIH0sCiAgICAgICAgICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICBtY3A6IHsKICAgICAgICAgICAgICAgICAgICBzZXJ2ZXJzOiB7CmludmFsaWQ6IHsgZGVjbGFyYXRpb246IHsga2luZDogJ2R5bmFtaWMnLCB0aXRsZTogJ0R5bmFtaWMnIH0gfSwKICAgICAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgfSk7 */
void 0; /* @sdk-negative-type-case-end */
            const hostOwnedAcpDefinition = {
                declaration: {
                    title: 'ACP Agent',
                    runtime: {
                        kind: 'acp',
                        transport: {
                            kind: 'tcp',
                            host: '127.0.0.1',
                            port: 4321,
                        },
                    },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                },
            } satisfies PluginAgentDefinition;
            const registrationOwnedLocator = {
                module: './agent/runtime/factory.js',
                export: 'createAgentRuntime',
                runtimeApiVersion: 1,
                externalSessionsExport: 'externalSessions',
            } satisfies AgentSessionRunnerFactoryLocatorV1;
            /* @sdk-negative-type-case:src-definePlugin-test-ts-5:SG9zdC1vd25lZCBkZWNsYXJhdGl2ZSBBQ1AgaGFzIG5vIHBsdWdpbiByZWdpc3RyYXRpb24gb3IgYmluZGluZyBhZGFwdGVyLg:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgICAgIGlkOiAnZXhhbXBsZS5pbnZhbGlkLWhvc3Qtb3duZWQtYWdlbnQtYWRhcHRlcicsCiAgICAgICAgICAgICAgICB2ZXJzaW9uOiAnMC4xLjAnLAogICAgICAgICAgICAgICAgYWdlbnRzOiB7CmFjcDogewogICAgICAgICAgICAgICAgICAgICAgICAuLi5ob3N0T3duZWRBY3BEZWZpbml0aW9uLAogICAgICAgICAgICAgICAgICAgICAgICBwcm92aWRlckJpbmRpbmc6IHt9IGFzIEFnZW50UHJvdmlkZXJCaW5kaW5nQWRhcHRlciwKICAgICAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgfSk7 */
void 0; /* @sdk-negative-type-case-end */
            /* @sdk-negative-type-case:src-definePlugin-test-ts-6:SG9zdC1vd25lZCBkZWNsYXJhdGl2ZSBBQ1AgaGFzIG5vIHBsdWdpbiBydW5uZXIgbG9jYXRvciBvciBleHBvcnRlZCBydW50aW1lIGxlYWYu:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgICAgIGlkOiAnZXhhbXBsZS5pbnZhbGlkLWhvc3Qtb3duZWQtYWdlbnQtZXh0ZXJuYWwtc2Vzc2lvbnMtZXhwb3J0JywKICAgICAgICAgICAgICAgIHZlcnNpb246ICcwLjEuMCcsCiAgICAgICAgICAgICAgICBhZ2VudHM6IHsKYWNwOiB7CiAgICAgICAgICAgICAgICAgICAgICAgIC4uLmhvc3RPd25lZEFjcERlZmluaXRpb24sCiAgICAgICAgICAgICAgICAgICAgICAgIHNlc3Npb25SdW5uZXJGYWN0b3J5OiByZWdpc3RyYXRpb25Pd25lZExvY2F0b3IsCiAgICAgICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgIH0pOw */
void 0; /* @sdk-negative-type-case-end */
        }
    });

    it('rejects a cast host-owned declarative ACP runner locator at runtime', () => {
        const defineHostOwnedAgentWithLocator = () => definePlugin({
            id: 'example.invalid-host-owned-agent-external-sessions-export-runtime',
            version: '0.1.0',
            agents: {
                acp: {
                    declaration: {
                        title: 'ACP Agent',
                        runtime: {
                            kind: 'acp',
                            transport: {
                                kind: 'tcp',
                                host: '127.0.0.1',
                                port: 4321,
                            },
                        },
                        primary: 'sessions',
                        capabilities: {
                            sessions: {
                                open: ['create'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                    },
                    sessionRunnerFactory: {
                        module: './agent/runtime/factory.js',
                        export: 'createAgentRuntime',
                        runtimeApiVersion: 1,
                        externalSessionsExport: 'externalSessions',
                    },
                },
            },
        } as unknown as Parameters<typeof definePlugin>[0]);

        expect(defineHostOwnedAgentWithLocator).toThrow(
                /cannot declare a custom Session runner leaf/iu,
        );
    });

    it('relates the declared externalSessions surface to its runtime facets at compile time', () => {
        if (false) {
            const externalSessionsContribution = {} as AgentExternalSessionsContribution;
            void externalSessionsContribution;
            /* @sdk-negative-type-case:src-definePlugin-test-ts-external-sessions-surface-without-contribution:QW4gQWdlbnQgZGVjbGFyaW5nIHRoZSBleHRlcm5hbFNlc3Npb25zIHN1cmZhY2UgcmVxdWlyZXMgaXRzIEV4dGVybmFsIFNlc3Npb25zIGNvbnRyaWJ1dGlvbi4:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgICAgIGlkOiAnZXhhbXBsZS5pbnZhbGlkLWV4dGVybmFsLXNlc3Npb25zLXN1cmZhY2Utd2l0aG91dC1jb250cmlidXRpb24nLAogICAgICAgICAgICAgICAgdmVyc2lvbjogJzAuMS4wJywKICAgICAgICAgICAgICAgIGFnZW50czogewphdXhpbGlhcnk6IHsKICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb246IHsKICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRpdGxlOiAnQXV4aWxpYXJ5IEFnZW50JywKICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhcGFiaWxpdGllczogeyBzdXJmYWNlczogWydleHRlcm5hbFNlc3Npb25zJ10gfSwKICAgICAgICAgICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgfSk7 */
void 0; /* @sdk-negative-type-case-end */
            /* @sdk-negative-type-case:src-definePlugin-test-ts-external-sessions-contribution-without-surface:RXh0ZXJuYWwgU2Vzc2lvbnMgcnVudGltZSBmYWNldHMgcmVxdWlyZSB0aGUgZGVjbGFyZWQgZXh0ZXJuYWxTZXNzaW9ucyBzdXJmYWNlLg:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgICAgIGlkOiAnZXhhbXBsZS5pbnZhbGlkLWV4dGVybmFsLXNlc3Npb25zLWNvbnRyaWJ1dGlvbi13aXRob3V0LXN1cmZhY2UnLAogICAgICAgICAgICAgICAgdmVyc2lvbjogJzAuMS4wJywKICAgICAgICAgICAgICAgIGFnZW50czogewogICAgICAgICAgICAgICAgICAgIGF1eGlsaWFyeTogewogICAgICAgICAgICAgICAgICAgICAgICBkZWNsYXJhdGlvbjogewogICAgICAgICAgICAgICAgICAgICAgICAgICAgdGl0bGU6ICdBdXhpbGlhcnkgQWdlbnQnLAogICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FwYWJpbGl0aWVzOiB7IHN1cmZhY2VzOiBbJ3Rlcm1pbmFsJ10gfSwKICAgICAgICAgICAgICAgICAgICAgICAgfSwKZXh0ZXJuYWxTZXNzaW9uczogZXh0ZXJuYWxTZXNzaW9uc0NvbnRyaWJ1dGlvbiwKICAgICAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgfSk7 */
void 0; /* @sdk-negative-type-case-end */
        }
    });

    it('keeps the External Sessions authoring guard for capability lists no literal survives', () => {
        // A JavaScript author, and every bundled Agent whose capability list is
        // projected at runtime, reaches `definePlugin` with a widened surface
        // array. The compile-time rule above cannot read one, so the runtime
        // guard stays the owner of both directions for them.
        const projectedSurfaces: ('terminal' | 'externalSessions')[] = ['externalSessions'];
        expect(() => definePlugin({
            id: 'example.widened-external-sessions-surface-without-contribution',
            version: '0.1.0',
            agents: {
                auxiliary: {
                    declaration: {
                        title: 'Auxiliary Agent',
                        capabilities: { surfaces: projectedSurfaces },
                        surfaces: {
                            externalSession: {
                                sources: [{
                                    sourceKind: 'fixture',
                                    schema: { fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }] },
                                    key: { segments: [{ kind: 'literal', value: 'fixture' }] },
                                }],
                            },
                        },
                    },
                },
            },
        })).toThrow(/requires an External Sessions contribution/u);

        const projectedTerminalSurfaces: ('terminal' | 'externalSessions')[] = ['terminal'];
        expect(() => definePlugin({
            id: 'example.widened-external-sessions-contribution-without-surface',
            version: '0.1.0',
            agents: {
                auxiliary: {
                    declaration: {
                        title: 'Auxiliary Agent',
                        capabilities: { surfaces: projectedTerminalSurfaces },
                    },
                    externalSessions: {} as AgentExternalSessionsContribution,
                },
            },
        })).toThrow(/without declaring the External Sessions surface/u);
    });

    it('infers composable action input and result types without explicit generics', () => {
        const inputSchema = defineComposableProtocolObject({
            text: defineComposableProtocolString(),
        }, { policy: 'closed' });
        const resultSchema = defineComposableProtocolObject({
            length: defineComposableProtocolNumber(),
        }, { policy: 'closed' });
        definePlugin({
            id: 'example.action-inference',
            version: '0.1.0',
            actions: {
                inspect: {
                    title: 'Inspect',
                    execution: { target: 'daemon' },
                    inputSchema,
                    resultSchema,
                    async run(input) {
                        return { length: input.text.length };
                    },
                },
            },
        });

        if (false) {
            definePlugin({
                id: 'example.action-projection-is-structural',
                version: '0.1.0',
                actions: {
                    inspect: {
                        title: 'Inspect structural projection',
                        execution: { target: 'daemon' },
                        inputSchema: inputSchema.jsonSchema,
                        async run(input) {
                            expectTypeOf(input).toEqualTypeOf<JsonValue>();
                            /* @sdk-negative-type-case:src-definePlugin-test-ts-json-schema-inference:QSBwbGFpbiBKU09OLXNjaGVtYSBwcm9qZWN0aW9uIGNhcnJpZXMgbm8gY29tcG9zYWJsZSBmaWVsZCBpbmZlcmVuY2Uu:dm9pZCBpbnB1dC50ZXh0Ow */
                            void undefined; /* @sdk-negative-type-case-end */
                            return input;
                        },
                    },
                },
            });
        }

        /* @sdk-negative-type-case:src-definePlugin-test-ts-7:VGhlIHJlc3VsdCBzY2hlbWEgcmVxdWlyZXMgYSBudW1lcmljIGxlbmd0aC4:ZGVmaW5lUGx1Z2luKHsKICAgICAgICAgICAgaWQ6ICdleGFtcGxlLmFjdGlvbi1pbmZlcmVuY2UtaW52YWxpZCcsCiAgICAgICAgICAgIHZlcnNpb246ICcwLjEuMCcsCiAgICAgICAgICAgIGFjdGlvbnM6IHsKICAgICAgICAgICAgICAgIGluc3BlY3Q6IHsKICAgICAgICAgICAgICAgICAgICB0aXRsZTogJ0luc3BlY3QnLAogICAgICAgICAgICAgICAgICAgIGlucHV0U2NoZW1hLAogICAgICAgICAgICAgICAgICAgIHJlc3VsdFNjaGVtYSwKYXN5bmMgcnVuKGlucHV0KSB7CiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGxlbmd0aDogaW5wdXQudGV4dCB9OwogICAgICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICB9LAogICAgICAgIH0pOw */
void 0; /* @sdk-negative-type-case-end */
        /* @sdk-negative-type-case:src-definePlugin-test-ts-composer-operation:Q29tcG9zZXIgZGVjbGFyYXRpdmUgY29tcG9zZXJBcHBseSBlZmZlY3RzIG11c3QgY2FycnkgYSBjYW5vbmljYWwgQ29tcG9zZXIgb3BlcmF0aW9uLCBub3QgYXJiaXRyYXJ5IEpTT04u:ZGVmaW5lUGx1Z2luKHsgaWQ6ICdleGFtcGxlLmNvbXBvc2VyLWludmFsaWQtb3BlcmF0aW9uJywgdmVyc2lvbjogJzAuMS4wJywgY29tcG9zZXI6IHsgY29udHJvbHM6IHsgaW52YWxpZDogeyBsYWJlbDogJ0ludmFsaWQnLCBpY29uOiAnZXJyb3InLCBpbnRlcmFjdGlvbjogeyBraW5kOiAnY2hvaWNlcycsIHNlbGVjdGlvbjogJ3NpbmdsZScsIG9wdGlvbnM6IFt7IGlkOiAnaW52YWxpZCcsIGxhYmVsOiAnSW52YWxpZCcsIGVmZmVjdDogeyBraW5kOiAnY29tcG9zZXJBcHBseScsIG9wZXJhdGlvbnM6IFt7IGtpbmQ6ICdhdHRhY2htZW50LmFkZCcsIGF0dGFjaG1lbnRMb2NhbElkOiAnaXNzdWUnIH1dIH0gfV0gfSB9IH0gfSB9KTs= */
void 0; /* @sdk-negative-type-case-end */
    });

    it('publishes only the final contribution constructors and requires executable protocol schemas', () => {
        const defineContributionProtocol = Reflect.get(
            contributionAuthoring,
            'defineContributionProtocol',
        ) as unknown;
        const defineContributionPoint = Reflect.get(
            contributionAuthoring,
            'defineContributionPoint',
        ) as unknown;

        expect(defineContributionProtocol).toEqual(expect.any(Function));
        expect(defineContributionPoint).toEqual(expect.any(Function));
        expect(contributionAuthoring).not.toHaveProperty('defineTargetedContributionProtocol');
        expect(contributionAuthoring).not.toHaveProperty('defineTargetedContributionPoint');

        expect(() => {
            if (typeof defineContributionProtocol !== 'function') {
                throw new TypeError('defineContributionProtocol is missing');
            }
            defineContributionProtocol({
                id: 'raw-schema-rejected',
                version: 1,
                operations: {
                    inspect: {
                        required: true,
                        input: { kind: 'contributorDefined' },
                        // A raw JSON Schema is manifest data, not executable authoring input.
                        resultSchema: { jsonSchema: { type: 'object' } },
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                },
            });
        }).toThrow(/executable protocol schema/i);

        const incompleteComposableSchema = {
            jsonSchema: { type: 'object' },
            parse(value: unknown) {
                return value;
            },
            safeParse(value: unknown) {
                return { success: true as const, data: value };
            },
        };
        expect(() => {
            if (typeof defineContributionProtocol !== 'function') {
                throw new TypeError('defineContributionProtocol is missing');
            }
            defineContributionProtocol({
                id: 'partial-composable-schema-rejected',
                version: 1,
                operations: {
                    inspect: {
                        required: true,
                        input: { kind: 'contributorDefined' },
                        resultSchema: incompleteComposableSchema,
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                },
            });
        // A partial parser lookalike is simply not the executable surface;
        // the executable-schema requirement rejects it without the SDK
        // classifying near-misses on its own.
        }).toThrow(/executable protocol schema/i);
    });

    it('rejects incomplete action schema lookalikes at the canonical JSON Schema owner', () => {
        const incompleteComposableSchema = {
            jsonSchema: { type: 'string' },
            parse(value: unknown) {
                return value;
            },
            safeParse(value: unknown) {
                return { success: true as const, data: value };
            },
        };

        expect(() => definePlugin({
            id: 'example.partial-composable-action-schema',
            version: '0.1.0',
            actions: {
                inspect: {
                    title: 'Inspect',
                    execution: { target: 'daemon' },
                    // Invalid JavaScript can still cross the author boundary;
                    // bypass the new static contract only to exercise its
                    // canonical runtime rejection.
                    inputSchema: incompleteComposableSchema as unknown as NonNullable<
                        PluginActionDeclaration['inputSchema']
                    >,
                    run: (input) => input,
                },
            },
        // Not the executable surface, so it is the declared JSON Schema arm.
        // Protocol's normalizer is the one owner that admits or rejects that
        // arm, and executable members are not strict JSON.
        })).toThrow(/Invalid plugin JSON Schema/i);
    });

    it('rejects malformed contribution protocol ids before authoring projects a manifest', () => {
        const valid = defineContributionProtocol({
            id: 'happier.channels/providers',
            version: 1,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });

        expect(valid.id).toBe('happier.channels/providers');
        expect(valid.point().protocols).toMatchObject([
            { id: 'happier.channels/providers', version: 1 },
        ]);

        for (const id of [
            'happier.channels.providers',
            'happier..channels/providers',
            'happier.channels//providers',
        ]) {
            expect(() => defineContributionProtocol({
                id,
                version: 1,
                operations: {
                    setup: {
                        required: true,
                        input: { kind: 'contributorDefined' },
                        resultSchema: contributionResultSchema,
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                },
            }), id).toThrow();
        }
    });

    it('accepts lower-camel operation roles and rejects malformed roles before projecting point or contributor manifests', () => {
        const operation = {
            required: true,
            input: { kind: 'contributorDefined' as const },
            resultSchema: contributionResultSchema,
            action: { surface: 'plugin' as const, dangerLevel: 'safe' as const },
        };

        const protocol = defineContributionProtocol({
            id: 'channels-providers',
            version: 1,
            operations: { connectionTest: operation },
        });
        expect(protocol.point().protocols[0]?.operations).toHaveProperty('connectionTest');
        expect(protocol.contribute({
            operations: { connectionTest: 'arbitrary-action' },
        }).operations).toEqual({ connectionTest: 'arbitrary-action' });

        for (const role of ['connection Test', 'connection\\Test', '../connectionTest', 'ConnectionTest']) {
            expect(() => defineContributionProtocol({
                id: 'channels-providers',
                version: 1,
                operations: { [role]: operation },
            }), role).toThrow();
        }

        const contribute = Reflect.get(protocol, 'contribute');
        if (typeof contribute !== 'function') throw new Error('Contribution protocol must expose contribute');
        expect(() => Reflect.apply(contribute, protocol, [{
            operations: { 'connection Test': 'arbitrary-action' },
        }])).toThrow();
    });

  it('projects target points and arbitrary same-plugin Action bindings through one author declaration', () => {
        const setupInputSchema = defineProtocolObject({
            repository: defineProtocolString(),
        }, { policy: 'closed' });
        const setupResultSchema = defineProtocolObject({
            accepted: defineProtocolUnion([
                defineProtocolLiteral(true),
                defineProtocolLiteral(false),
            ]),
        }, { policy: 'closed' });
        const protocol = defineContributionProtocol({
            id: 'channels-providers',
            version: 1,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'protocolDefined', schema: setupInputSchema },
                    resultSchema: setupResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const target = definePlugin({
            id: 'happier.channels',
            version: '0.1.0',
            contributionPoints: {
                providers: protocol.point({ maxContributionsPerContributor: 1 }),
            },
        });
        const telegramContribution = protocol.contribute({
            operations: { setup: protocol.operations.setup.bind('arbitrary') },
        });
        expect(Object.getOwnPropertySymbols(telegramContribution)).toEqual([]);

        const contributor = definePlugin({
            id: 'happier.channels.telegram',
            version: '0.1.0',
            actions: {
                arbitrary: {
                    title: 'Arbitrary',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    dangerLevel: 'safe',
                    run: async () => ({}),
                },
            },
            contributesTo: {
                'happier.channels': {
                    providers: {
                        telegram: telegramContribution,
                    },
                },
            },
        });

        expect(target.manifest.contributes.pluginContributionPoints).toMatchObject([{
            id: 'providers',
            maxContributionsPerContributor: 1,
            protocols: [{ id: 'channels-providers', version: 1 }],
        }]);
        expect(target.contributionPoints.providers).toEqual({
            targetPluginId: 'happier.channels',
            id: 'providers',
            protocol: { id: 'channels-providers', version: 1 },
        });
        type AdmittedProvider = typeof target.contributionPoints.providers extends TargetedContributionPointRef<
            infer TContribution
        > ? TContribution : never;
        expectTypeOf<AdmittedProvider>().toHaveProperty('contributor');
        expectTypeOf<AdmittedProvider['contributor']>().toEqualTypeOf<Readonly<{
            pluginId: string;
            contributionId: string;
            immutableGenerationId: string;
        }>>();
        type AdmittedSnapshot = TargetedContributionSnapshot<AdmittedProvider>;
        expectTypeOf<AdmittedSnapshot['contributions'][number]['contributor']>().toEqualTypeOf<
            AdmittedProvider['contributor']
        >();
        const executeSetup = (
            actions: ActionsService,
            admitted: AdmittedProvider,
        ): Promise<{ accepted: boolean }> => {
            const operation: AdmittedTargetedOperationExecutionHandle<
                { repository: string },
                { accepted: boolean },
                'setup'
            > = admitted.operations.setup;
            return actions.executeAdmittedTargetedOperation(operation, {
                repository: 'happier-dev/happier',
            });
        };
        expectTypeOf(executeSetup).returns.toEqualTypeOf<Promise<{ accepted: boolean }>>();
        expectTypeOf<AdmittedProvider['operations']['setup']['identity']['role']>()
            .toEqualTypeOf<'setup'>();
        const targetedPluginContributions = contributor.manifest.contributes.targetedPluginContributions ?? [];
        expect(targetedPluginContributions).toEqual([{
            id: 'telegram',
            target: { pluginId: 'happier.channels', pointId: 'providers' },
            protocol: { id: 'channels-providers', version: 1 },
            operations: { setup: 'arbitrary' },
        }]);
        const projectedContribution = targetedPluginContributions[0];
        expect(projectedContribution).toBeDefined();
        expect(Object.getOwnPropertySymbols(projectedContribution!)).toEqual([]);
        expect(JSON.parse(JSON.stringify(contributor.manifest))).toEqual(contributor.manifest);
        expect(contributor.actionContracts.arbitrary).toEqual({
            pluginId: 'happier.channels.telegram',
            localId: 'arbitrary',
        });

        /* @sdk-negative-type-case:src-definePlugin-test-ts-targeted-required:bWlzc2luZyByZXF1aXJlZCB0YXJnZXRlZCBjb250cmlidXRpb24gb3BlcmF0aW9u:cHJvdG9jb2wuY29udHJpYnV0ZSh7CiAgICBvcGVyYXRpb25zOiB7fSwKfSk7 */
void 0; /* @sdk-negative-type-case-end */

        /* @sdk-negative-type-case:src-definePlugin-test-ts-targeted-unknown-role:dW5rbm93biB0YXJnZXRlZCBjb250cmlidXRpb24gcm9sZQ:cHJvdG9jb2wuY29udHJpYnV0ZSh7CiAgICBvcGVyYXRpb25zOiB7CiAgICAgICAgc2V0dXA6IHByb3RvY29sLm9wZXJhdGlvbnMuc2V0dXAuYmluZCgnYXJiaXRyYXJ5JyksCiAgICAgICAgdW5zdXBwb3J0ZWQ6ICdhcmJpdHJhcnknLAogICAgfSwKfSk7 */
void 0; /* @sdk-negative-type-case-end */

        /* @sdk-negative-type-case:src-definePlugin-test-ts-targeted-action:bGFyZ2V0ZWQgY29udHJpYnV0aW9uIEFjdGlvbiBtdXN0IGJlIGRlY2xhcmVkIGJ5IGl0cyBjb250cmlidXRvcg:ZGVmaW5lUGx1Z2luKHsKICAgIGlkOiAnZXhhbXBsZS50YXJnZXRlZC1pbnZhbGlkLWFjdGlvbicsCiAgICB2ZXJzaW9uOiAnMC4xLjAnLAogICAgYWN0aW9uczogewogICAgICAgIGFyYml0cmFyeTogewogICAgICAgICAgICB0aXRsZTogJ0FyYml0cmFyeScsCiAgICAgICAgICAgIHNjb3BlczogWydnbG9iYWwnXSwKICAgICAgICAgICAgc3VyZmFjZXM6IFsncGx1Z2luJ10sCiAgICAgICAgICAgIGRhbmdlckxldmVsOiAnc2FmZScsCiAgICAgICAgICAgIHJ1bjogYXN5bmMgKCkgPT4gKHt9KSwKICAgICAgICB9LAogICAgfSwKICAgIGNvbnRyaWJ1dGVzVG86IHsKICAgICAgICAnaGFwcGllci5jaGFubmVscyc6IHsKICAgICAgICAgICAgcHJvdmlkZXJzOiB7CiAgICAgICAgICAgICAgICBpbnZhbGlkOiBwcm90b2NvbC5jb250cmlidXRlKHsKICAgICAgICAgICAgICAgICAgICBvcGVyYXRpb25zOiB7IHNldHVwOiBwcm90b2NvbC5vcGVyYXRpb25zLnNldHVwLmJpbmQoJ2RvZXMtbm90LWV4aXN0JykgfSwKICAgICAgICAgICAgICAgIH0pLAogICAgICAgICAgICB9LAogICAgICAgIH0sCiAgICB9LAp9KTs */
void 0; /* @sdk-negative-type-case-end */
    });

    it('projects trusted accessor-backed targeted declarations as cold facts', () => {
        const protocol = defineContributionProtocol({
            id: 'targeted-cold-projection',
            version: 1,
            operations: {
                run: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const contribution = protocol.contribute({
            operations: { run: protocol.operations.run.bind('arbitrary') },
        });
        const defineContributor = (definition: object) => Reflect.apply(definePlugin, undefined, [{
            id: 'happier.targeted.cold-projection',
            version: '0.1.0',
            actions: {
                arbitrary: {
                    title: 'Arbitrary',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    dangerLevel: 'safe',
                    run: async () => ({}),
                },
            },
            contributesTo: {
                'happier.targeted': {
                    points: {
                        contribution: definition,
                    },
                },
            },
        }]);

        let accessorRead = false;
        const accessorBacked = { ...contribution };
        Object.defineProperty(accessorBacked, 'operations', {
            enumerable: true,
            get() {
                accessorRead = true;
                return contribution.operations;
            },
        });
        const plugin = defineContributor(accessorBacked);
        expect(accessorRead).toBe(true);
        expect(plugin.manifest.contributes.targetedPluginContributions).toMatchObject([{
            id: 'contribution',
            protocol: { id: 'targeted-cold-projection', version: 1 },
            operations: { run: 'arbitrary' },
        }]);

    });

    it('composes a readonly definePlugin point declaration into the manual manifest ABI without copying it', () => {
        const protocol = defineContributionProtocol({
            id: 'channels-providers',
            version: 1,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const definition = definePlugin({
            id: 'happier.channels',
            version: '0.1.0',
            contributionPoints: {
                providers: protocol.point({ maxContributionsPerContributor: 1 }),
            },
        });
        const manualManifest = {
            schemaVersion: 2,
            id: 'happier.channels.composed',
            version: '0.1.0',
            displayName: 'Composed Channels',
            engines: { happier: '^0.1.0' },
            runtime: { apiVersion: 1 },
            contributes: {
                pluginContributionPoints:
                    definition.manifest.contributes.pluginContributionPoints,
            },
        } as const satisfies PluginManifest;

        expect(manualManifest.contributes.pluginContributionPoints)
            .toBe(definition.manifest.contributes.pluginContributionPoints);
        expect(manualManifest.contributes.pluginContributionPoints).toMatchObject([{
            id: 'providers',
            maxContributionsPerContributor: 1,
            protocols: [{ id: 'channels-providers', version: 1 }],
        }]);

        const firstNonJsonPath = (value: unknown, path = '$'): string | null => {
            if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
            if (typeof value === 'number') return Number.isFinite(value) ? null : path;
            if (typeof value !== 'object') return path;
            if (Array.isArray(value)) {
                for (const [index, entry] of value.entries()) {
                    const invalidPath = firstNonJsonPath(entry, `${path}[${index}]`);
                    if (invalidPath !== null) return invalidPath;
                }
                return null;
            }
            const prototype = Object.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null) return path;
            if (Object.getOwnPropertySymbols(value).length > 0) return path;
            for (const key of Object.getOwnPropertyNames(value)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (descriptor === undefined || !('value' in descriptor)) return `${path}.${key}`;
                const invalidPath = firstNonJsonPath(descriptor.value, `${path}.${key}`);
                if (invalidPath !== null) return invalidPath;
            }
            return null;
        };

        expect(firstNonJsonPath(manualManifest)).toBeNull();
        expect(JSON.parse(JSON.stringify(manualManifest))).toEqual(manualManifest);

        const parsed = parsePluginManifest(manualManifest);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error('Expected composed manual manifest to parse');
        expect(parsed.manifest.contributes.pluginContributionPoints).toEqual(
            manualManifest.contributes.pluginContributionPoints,
        );
        expect(definition.contributionPoints.providers).toEqual({
            targetPluginId: 'happier.channels',
            id: 'providers',
            protocol: { id: 'channels-providers', version: 1 },
        });
    });

    it('exposes immutable role declaration facts for an ordinary same-plugin Action', () => {
        const connectionTestInputSchema = defineProtocolObject({
            connectionId: defineProtocolString(),
        }, { policy: 'closed' });
        const connectionTestResultSchema = defineProtocolObject({
            ready: defineProtocolUnion([
                defineProtocolLiteral(true),
                defineProtocolLiteral(false),
            ]),
        }, { policy: 'closed' });
        const protocol = defineContributionProtocol({
            id: 'channels-provider-operations',
            version: 1,
            operations: {
                connectionTest: {
                    required: true,
                    input: { kind: 'protocolDefined', schema: connectionTestInputSchema },
                    resultSchema: connectionTestResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'writesRemote' },
                },
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const connectionTest = protocol.operations.connectionTest;
        const setup = protocol.operations.setup;

        if (connectionTest.declaration.input.kind !== 'protocolDefined') {
            throw new TypeError('Expected a protocol-defined connection-test input');
        }
        const contributor = definePlugin({
            id: 'example.arbitrary-provider-local-id',
            version: '0.1.0',
            actions: {
                'arbitrary-connection-test': {
                    title: 'Arbitrary connection test',
                    execution: { target: 'daemon' },
                    inputSchema: connectionTest.declaration.input.schema.jsonSchema,
                    resultSchema: connectionTest.declaration.resultSchema.jsonSchema,
                    surfaces: connectionTest.declaration.surfaces,
                    dangerLevel: connectionTest.declaration.dangerLevel,
                    async run(input) {
                        const parsedInput = connectionTest.declaration.input.schema.parse(input);
                        return { ready: parsedInput.connectionId === 'connection-42' };
                    },
                },
            },
        });

        expect(Object.getOwnPropertyNames(connectionTest).sort()).toEqual(['bind', 'declaration']);
        expect(Object.isFrozen(connectionTest)).toBe(true);
        expect(connectionTest.declaration).toEqual({
            required: true,
            input: { kind: 'protocolDefined', schema: connectionTestInputSchema },
            resultSchema: connectionTestResultSchema,
            dangerLevel: 'writesRemote',
            surfaces: ['plugin'],
        });
        expect(connectionTest.declaration.input.schema).toBe(connectionTestInputSchema);
        expect(connectionTest.declaration.resultSchema).toBe(connectionTestResultSchema);
        expect(Object.isFrozen(connectionTest.declaration)).toBe(true);
        expect(Object.isFrozen(connectionTest.declaration.input)).toBe(true);
        expect(Object.isFrozen(connectionTest.declaration.surfaces)).toBe(true);
        expect(connectionTest.bind('arbitrary-connection-test')).toBe('arbitrary-connection-test');

        expect(setup.declaration).toMatchObject({
            input: { kind: 'contributorDefined' },
            resultSchema: contributionResultSchema,
            dangerLevel: 'safe',
            surfaces: ['plugin'],
        });
        expect(Object.isFrozen(setup.declaration)).toBe(true);
        expect(Object.isFrozen(setup.declaration.input)).toBe(true);
        expect(Object.isFrozen(setup.declaration.surfaces)).toBe(true);
        expect(setup.bind('a-provider-local-setup')).toBe('a-provider-local-setup');

        expect(contributor.manifest.contributes.actions).toEqual([expect.objectContaining({
            id: 'arbitrary-connection-test',
            inputSchema: connectionTestInputSchema.jsonSchema,
            resultSchema: connectionTestResultSchema.jsonSchema,
            surfaces: ['plugin'],
            dangerLevel: 'writesRemote',
        })]);

        type ConnectionTestDeclaration = typeof connectionTest.declaration;
        type SetupDeclaration = typeof setup.declaration;
        expectTypeOf<ConnectionTestDeclaration['input']>().toEqualTypeOf<Readonly<{
            kind: 'protocolDefined';
            schema: typeof connectionTestInputSchema;
        }>>();
        expectTypeOf<ConnectionTestDeclaration['resultSchema']>().toEqualTypeOf<typeof connectionTestResultSchema>();
        expectTypeOf<ConnectionTestDeclaration['dangerLevel']>().toEqualTypeOf<'writesRemote'>();
        expectTypeOf<ConnectionTestDeclaration['surfaces']>().toEqualTypeOf<readonly ['plugin']>();
        expectTypeOf<SetupDeclaration['input']>().toEqualTypeOf<Readonly<{
            kind: 'contributorDefined';
        }>>();
    });

    it('projects target-owned descriptor and surface contracts while exposing only a pointId surface handle', () => {
        const descriptorSchema = defineProtocolObject({
            providerId: defineProtocolString(),
        }, { policy: 'closed' });
        const detailInputSchema = defineProtocolObject({
            issueId: defineProtocolString(),
        }, { policy: 'closed' });
        const protocol = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            descriptor: descriptorSchema,
            operations: {
                inspect: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: detailInputSchema,
                    presentation: 'content',
                },
            },
        });
        const target = definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: {
                sources: protocol.point(),
            },
        });
        const contributor = definePlugin({
            id: 'happier.triage.github',
            version: '0.1.0',
            actions: {
                inspect: {
                    title: 'Inspect source',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    dangerLevel: 'safe',
                    run: async () => ({}),
                },
            },
            ui: {
                renderers: [{
                    id: 'triage-detail',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Provider detail' },
                }],
            },
            contributesTo: {
                'happier.triage': {
                    sources: {
                        github: protocol.contribute({
                            descriptor: { providerId: 'github' },
                            operations: { inspect: protocol.operations.inspect.bind('inspect') },
                            surfaces: { detail: { renderer: 'triage-detail' } },
                        }),
                    },
                },
            },
        });

        expect(target.manifest.contributes.pluginContributionPoints).toMatchObject([{
            id: 'sources',
            protocols: [{
                id: 'triage-source',
                version: 1,
                descriptor: descriptorSchema.jsonSchema,
                surfaces: {
                    detail: {
                        required: true,
                        inputSchema: detailInputSchema.jsonSchema,
                        presentation: 'content',
                    },
                },
            }],
        }]);
        expect(contributor.manifest.contributes.targetedPluginContributions).toEqual([{
            id: 'github',
            target: { pluginId: 'happier.triage', pointId: 'sources' },
            protocol: { id: 'triage-source', version: 1 },
            descriptor: { providerId: 'github' },
            operations: { inspect: 'inspect' },
            surfaces: { detail: { renderer: 'triage-detail' } },
        }]);

        type AdmittedSource = typeof target.contributionPoints.sources extends TargetedContributionPointRef<
            infer TContribution
        > ? TContribution : never;
        type DetailSurface = AdmittedSource['surfaces']['detail'];
        type DetailInput = DetailSurface extends ContributionSurfaceHandle<infer TInput, string> ? TInput : never;
        expectTypeOf<AdmittedSource['descriptor']['providerId']>().toEqualTypeOf<string>();
        // A declared descriptor schema makes the admitted descriptor REQUIRED:
        // admission rejects the contribution that omits it, so a target reader
        // must not be forced to narrow a value that cannot be absent.
        expectTypeOf<undefined extends AdmittedSource['descriptor'] ? true : false>().toEqualTypeOf<false>();
        expectTypeOf<DetailInput['issueId']>().toEqualTypeOf<string>();
        expectTypeOf<DetailSurface['point']>().toEqualTypeOf<Readonly<{
            pointId: 'sources';
            protocol: Readonly<{ id: string; version: number }>;
        }>>();
        expectTypeOf<DetailSurface['point']>().not.toHaveProperty('id');
  });

  it('builds a declarative targeted Surface node from one target-local surface role', () => {
    const detailInput = defineProtocolObject({ reviewId: defineProtocolString() }, { policy: 'closed' });
    const protocol = defineContributionProtocol({
        id: 'review-detail',
        version: 1,
        operations: {},
        surfaces: {
            detail: {
                required: true,
                inputSchema: detailInput,
                presentation: 'content',
            },
        },
    });
    const authoredInput = { reviewId: 'review-42' };
    const node = protocol.surfaces.detail.node({
      pointId: 'details',
      contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
      input: authoredInput,
      instanceKey: 'review-42',
      fallback: { kind: 'state', state: 'loading', title: 'Loading review' },
    });
    authoredInput.reviewId = 'mutated-after-authoring';

    expect(node).toEqual({
        kind: 'targetedSurface',
        surface: {
            point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
            contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
            role: 'detail',
        },
        input: { reviewId: 'review-42' },
        instanceKey: 'review-42',
        fallback: { kind: 'state', state: 'loading', title: 'Loading review' },
    });
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.surface)).toBe(true);
    expect(Object.isFrozen(node.surface.point)).toBe(true);
    expect(Object.isFrozen(node.surface.contributor)).toBe(true);
    expect(Object.isFrozen(node.input)).toBe(true);
    expect(Object.isFrozen(node.fallback)).toBe(true);
    expect(() => protocol.surfaces.detail.node({
        pointId: 'details',
        contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
        input: { reviewId: 42 } as never,
        instanceKey: 'review-42',
    })).toThrow(/Protocol schema validation failed/iu);
  });

  it('keeps targeted-surface node authoring free of a generic JSON node budget', () => {
    const detailInput = defineProtocolJsonValue();
    const protocol = defineContributionProtocol({
      id: 'review-detail',
      version: 1,
      operations: {},
      surfaces: {
        detail: {
          required: true,
          inputSchema: detailInput,
          presentation: 'content',
        },
      },
    });
    // The generic Protocol JSON schema admits this input. Targeted-surface
    // node authoring must preserve that strict ordinary-JSON value without
    // borrowing a generic count quota from an unrelated boundary.
    const oneOverTargetedSurfaceNodeBudget = Array.from({ length: 8_179 }, () => null);

    expect(() => protocol.surfaces.detail.node({
      pointId: 'details',
      contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
      input: oneOverTargetedSurfaceNodeBudget,
      instanceKey: 'review-42',
    })).not.toThrow();
  });

  it('emits targeted Surface symbolic-wrapper facts without manifest admission', () => {
    const detailInput = defineProtocolObject({ reviewId: defineProtocolString() }, { policy: 'closed' });
    const protocol = defineContributionProtocol({
        id: 'review-detail',
        version: 1,
        operations: {},
        surfaces: {
            detail: {
                required: true,
                inputSchema: detailInput,
                presentation: 'content',
            },
        },
    });
    const node = protocol.surfaces.detail.node({
        pointId: 'details',
        contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
        input: { reviewId: 'review-42' },
        instanceKey: 'review-42',
    });
    const defineRendererPlugin = (root: unknown) => definePlugin({
        id: 'com.acme.review.surface',
        version: '0.1.0',
        ui: {
            renderers: [{
                id: 'review-detail',
                kind: 'declarative',
                root,
            }],
        },
    } as unknown as Parameters<typeof definePlugin>[0]);

    expect(() => defineRendererPlugin(node)).not.toThrow();
    expect(() => defineRendererPlugin({
        ...node,
        surface: {
            ...node.surface,
            point: {
                id: 'details',
                protocol: node.surface.point.protocol,
            },
        },
    })).not.toThrow();
  });

  it('rejects accessor-backed symbolic fallback data without reading it', () => {
    const detailInput = defineProtocolObject({ reviewId: defineProtocolString() }, { policy: 'closed' });
    const protocol = defineContributionProtocol({
        id: 'review-detail',
        version: 1,
        operations: {},
        surfaces: {
            detail: {
                required: true,
                inputSchema: detailInput,
                presentation: 'content',
            },
        },
    });
    let reads = 0;
    const accessorTitle: unknown[] = [];
    Object.defineProperty(accessorTitle, '0', {
        enumerable: true,
        get() {
            reads += 1;
            return 'unexpected';
        },
    });

    expect(() => protocol.surfaces.detail.node({
        pointId: 'details',
        contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
        input: { reviewId: 'review-42' },
        instanceKey: 'review-42',
        fallback: {
            kind: 'state',
            state: 'loading',
            title: accessorTitle as never,
        },
    })).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it('authors each bounded protocol epoch at one point and exposes one typed ref per epoch', () => {
        const v1 = defineContributionProtocol({
            id: 'example-providers',
            version: 1,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const v2 = defineContributionProtocol({
            id: 'example-providers',
            version: 2,
            operations: {
                deliver: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const v3 = defineContributionProtocol({
            id: 'example-providers',
            version: 3,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const v4 = defineContributionProtocol({
            id: 'example-providers',
            version: 4,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const v5 = defineContributionProtocol({
            id: 'example-providers',
            version: 5,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: contributionResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const target = definePlugin({
            id: 'example.target',
            version: '0.1.0',
            contributionPoints: {
                providers: defineContributionPoint([v1, v2], {
                    maxContributionsPerContributor: 1,
                }),
            },
        });

        expect(target.manifest.contributes.pluginContributionPoints).toMatchObject([{
            id: 'providers',
            maxContributionsPerContributor: 1,
            protocols: [
                { id: 'example-providers', version: 1 },
                { id: 'example-providers', version: 2 },
            ],
        }]);
        expect(target.contributionPoints.providers).toEqual({
            protocols: [
                {
                    targetPluginId: 'example.target',
                    id: 'providers',
                    protocol: { id: 'example-providers', version: 1 },
                },
                {
                    targetPluginId: 'example.target',
                    id: 'providers',
                    protocol: { id: 'example-providers', version: 2 },
                },
            ],
        });
        expect(Object.keys(target.contributionPoints.providers.protocols[0]!))
            .toEqual(['targetPluginId', 'id', 'protocol']);
        expect(Object.keys(target.contributionPoints.providers.protocols[1]!))
            .toEqual(['targetPluginId', 'id', 'protocol']);
        type V1Contribution = typeof target.contributionPoints.providers.protocols[0] extends TargetedContributionPointRef<
            infer TContribution
        > ? TContribution : never;
        type V2Contribution = typeof target.contributionPoints.providers.protocols[1] extends TargetedContributionPointRef<
            infer TContribution
        > ? TContribution : never;
        expectTypeOf<V1Contribution['operations']>().toHaveProperty('setup');
        expectTypeOf<V1Contribution['operations']>().not.toHaveProperty('deliver');
        expectTypeOf<V2Contribution['operations']>().toHaveProperty('deliver');
        expectTypeOf<V2Contribution['operations']>().not.toHaveProperty('setup');

        expect(() => defineContributionPoint([v1, v1])).toThrow(/Duplicate contribution protocol identity/u);
        expect(() => defineContributionPoint([v1, v2, v3, v4, v5])).toThrow(/at most four protocol epochs/u);
    });
});
