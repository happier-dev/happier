import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type { PluginActivationModule, PluginApi, PluginCleanup } from './activation.js';
import type { PluginOperationAvailability } from './availability.js';
import { definePlugin } from './definePlugin.js';
import type { PluginDiagnosticData } from './diagnostics.js';
import { PluginError } from './errors.js';
import type { PluginErrorData } from './errors.js';
import {
    isRecord as projectedIsRecord,
    parseJsonLine as projectedParseJsonLine,
    parseTimestampMs as projectedParseTimestampMs,
    readString as projectedReadString,
    readTrimmedString as projectedReadTrimmedString,
} from './identity.js';
import type { JsonValue, PluginContributionRef, PluginReference } from './identity.js';
import type { PluginInvocationContext } from './invocation.js';
import type { Disposable, PluginCancellationOptions } from './lifecycle.js';
import type { LoggerService } from './services/core.js';
import type { PluginPath } from './services/io.js';
import type { PluginServiceId, PluginServices } from './services/index.js';
import { getActionSpec as projectedGetActionSpec } from './actions/index.js';
import type {
    ActionContribution,
    ActionExecuteResult,
    ActionHandler,
    ActionSpec,
    ActionsService,
    CommandContribution,
    PluginActionInputById,
    PluginActionResultById,
    PluginInvocableActionId,
    ToolContribution,
} from './actions/index.js';
import type {
    BackgroundServiceContext,
    BackgroundServiceContribution,
    BackgroundServiceDefinition,
    BackgroundServiceRunner,
    BackgroundServicesRegistrationApi,
} from './backgroundServices.js';
import { defineBrowserAction } from './browser/actions.js';
import type {
    BrowserActionContribution,
    BrowserActionContributionInput,
} from './browser/actions.js';
import { defineBrowserTarget } from './browser/targets.js';
import type {
    BrowserTargetContribution,
    BrowserTargetContributionInput,
} from './browser/targets.js';
import type {
    EventContribution,
    EventSubscriptionTarget,
    EventsService,
    HostEventEnvelope,
    HostEventId,
    HostEventPayloadById,
    HostEventScope,
    HostEventScopeById,
    HostEventTarget,
    HostEvents,
    PluginEventEmitResult,
    PluginEventEnvelope,
    PluginEventHandler,
    PluginEvents,
    PluginEventAutomationHistoryGapResetActionInputV1,
    PluginEventAutomationHistoryGapResetActionResultV1,
    PluginEventAutomationSetupResultV1,
} from './events.js';
import {
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionInputV1Schema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1Schema,
    PluginEventAutomationSetupResultV1Schema,
} from './events.js';
import type {
    AgentCliReadinessService,
    ExecSpawnRequest,
    ExecService,
    PluginExecSpawnRequest,
    PluginProcessHandle,
    PluginProcessObservedTermination,
    PluginProcessOutput,
    PluginProcessResult,
    PluginProcessTerminationRequest,
    ResolvedSystemTool,
    SystemToolContribution,
    SystemToolDiagnostic,
    SystemToolResolveRequest,
    SystemToolsService,
} from './exec.js';
import type {
    HttpMethod,
    HttpService,
    PluginFetchCredentialBinding,
    PluginWebSocketClose,
    PluginWebSocketConnection,
    PluginWebSocketHeader,
    PluginWebSocketMessage,
    PluginWebSocketOpenInput,
} from './http.js';
import type {
    ApprovalQueueListItem,
    ApprovalQueueQuery,
    ApprovalQueueRequest,
    ApprovalQueueRequestResult,
    ApprovalQueueService,
    ApprovalQueueSnapshot,
    ApprovalRequest,
    ApprovalRequestStatus,
    InteractionTerminalStatusV1,
    InteractionTransientApprovalAuthorRequestV1,
    InteractionTransientApprovalResultV1,
    InteractionTransientAuthorQuestionV1,
    InteractionTransientAuthorRequestV1,
    InteractionTransientChoiceSelectionV1,
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
    InteractionTransientResultV1,
    InteractionOptions,
    InteractionSeverity,
    InteractionsService,
    PluginInvocationSurface,
    PresentationService,
    UiWidget,
} from './interactions.js';
import {
    compilePluginJsonSchema as projectedCompilePluginJsonSchema,
    createPluginContributionIdentity as projectedCreatePluginContributionIdentity,
    isValidPluginJsonSchemaValue as projectedIsValidPluginJsonSchemaValue,
    parsePluginManifest as projectedParsePluginManifest,
} from './manifest.js';
import type {
    PluginContributes,
    PluginContributionIdentity,
    PluginManifest,
} from './manifest.js';
import { normalizeDetectedMcpServerV1 } from './mcp/index.js';
import type {
    DetectedMcpServerV1,
    McpAnnotations,
    McpBlobResourceContents,
    McpClient,
    McpDiscoveredEndpoint,
    McpDiscoveredServer,
    McpDiscoverySourceContribution,
    McpDiscoverySourceRef,
    McpDiscoveryRequest,
    McpDiscoveryResult,
    McpGetPromptResult,
    McpIcon,
    McpListToolsRequest,
    McpPageOptions,
    McpPrompt,
    McpPromptArgument,
    McpPromptContent,
    McpPromptMessage,
    McpPromptPage,
    McpReadResourceResult,
    McpResource,
    McpResourceContents,
    McpResourcePage,
    McpResourceTemplate,
    McpResourceTemplatePage,
    McpResourceUpdatedEvent,
    McpServerContribution,
    McpServerRef,
    McpServerRuntime,
    McpServerTransport,
    McpService,
    McpTextResourceContents,
    McpTool,
    McpToolCallContent,
    McpToolCallRequest,
    McpToolCallResult,
    McpToolPage,
    McpToolPageOptions,
    McpRegistrationApi,
} from './mcp/index.js';
import type {
    NotificationCategoryContribution,
    NotificationChannelContribution,
    NotificationPreferences,
    NotificationSendRequest,
    NotificationSendResult,
    NotificationSender,
    NotificationsService,
    PluginNotificationRegistrationApi,
} from './notifications.js';
import type {
    PluginResourceKind,
    PromptAssetAdapter,
    PromptAssetBundleRecord,
    PromptAssetCapabilities,
    PromptAssetContribution,
    PromptAssetDefaultRoot,
    PromptAssetDeleteRequest,
    PromptAssetDiscoverRequest,
    PromptAssetDiscoverResult,
    PromptAssetDiscoveryItem,
    PromptAssetDocRecord,
    PromptAssetExternalRef,
    PromptAssetInstallMode,
    PromptAssetLibraryKind,
    PromptAssetListTypesResult,
    PromptAssetMutationErrorCode,
    PromptAssetMutationPreview,
    PromptAssetMutationResult,
    PromptAssetReadRequest,
    PromptAssetReadResult,
    PromptAssetScope,
    PromptAssetSupportsScope,
    PromptAssetTypeDescriptor,
    PromptAssetWriteBundleRequest,
    PromptAssetWriteDocRequest,
    PromptAssetWriteRequest,
    PromptRegistryAdapterDescriptor,
    PromptRegistryConfiguredSource,
    PromptRegistryErrorCode,
    PromptRegistryErrorResult,
    PromptRegistryFetchItemRequest,
    PromptRegistryFetchItemResult,
    PromptRegistryFetchedItem,
    PromptRegistryInstallRequest,
    PromptRegistryInstallResult,
    PromptRegistryInstallTarget,
    PromptRegistryItemSummary,
    PromptRegistryListAdaptersResult,
    PromptRegistryListSourcesRequest,
    PromptRegistryListSourcesResult,
    PromptRegistryScanSourceRequest,
    PromptRegistryScanSourceResult,
    PromptRegistrySourceDescriptor,
    PromptRegistrySources,
    ResourceContribution,
    ResourceDescriptor,
    ResourcesService,
} from './resources.js';
import type {
    SecretMutationResult,
    SecretStatus,
    SecretsService,
} from './secrets.js';
import type {
    SettingDescriptor,
    SettingField,
    PluginSettingsActionDeclaration,
    PluginSettingsActionInput,
    PluginSettingsActionResult,
    PluginSettingsActionRuntime,
    SettingsChange,
    PluginSettingsContribution,
    SettingsService,
} from './settings/index.js';
import type {
    AccountKvEntry,
    AccountKvListItem,
    AccountKvService,
    AccountKvTransaction,
    PluginAccountStorageScope,
    StorageConsistency,
    StorageScopeService,
    StorageService,
    StorageTransaction,
} from './storage.js';
import type {
    DaemonDatabase,
    DaemonDatabaseExecutionResult,
    DaemonDatabaseIncumbentQueryFixture,
    DaemonDatabaseMigration,
    DaemonDatabaseMigrationDeclaration,
    DaemonDatabaseMigrationReadTransaction,
    DaemonDatabaseMigrationTransaction,
    DaemonDatabaseOperationOptions,
    DaemonDatabaseReadTransaction,
    DaemonDatabaseRow,
    DaemonDatabaseService,
    DaemonDatabaseStorageScope,
    DaemonDatabaseTransaction,
    DaemonDatabaseValue,
} from './storage/database.js';
import type {
    AgentSessionRuntimeEventSubscriber,
    AgentSessionRuntimeEventValidationFailure,
    AgentSessionRuntimeHarness,
    PluginTestServicesFixture,
    PluginTestkit,
    PluginTestkitInvokeActionOptions,
    PluginTestkitOptions,
    PluginTestkitRegistration,
    PluginTestkitRegistrationByFamily,
} from './testing/index.js';
import { createAgentSessionRuntimeHarness, createPluginTestkit } from './testing/index.js';
import { defineHostedWebBridgeMessage } from './ui.js';
import type {
    HostedWebBridgeEnvelopeV1,
    PluginUiChannel,
    PluginUiPlatform,
    RenderContext,
    RenderSurface,
    ResourceContent,
    SessionHeaderActionContribution,
    SurfaceContext,
    SurfaceHostMethod,
    UiRenderer,
    UiTranslationBundle,
    UiView,
} from './ui.js';
import {
    BUILD_CONFIG_BASENAMES,
    createReactNativeRepackSharedModules,
    createReactNativeWebVitePlugins,
    defineBuildConfig,
    defineReactNativeWebViteBuildPreset,
} from './ui/build/index.js';
import { getActionSpec as canonicalGetActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema as canonicalPluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionInputV1Schema as canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema as canonicalPluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1Schema as canonicalPluginEventAutomationHistoryGapResetActionResultV1Schema,
    PluginEventAutomationSetupResultV1Schema as canonicalPluginEventAutomationSetupResultV1Schema,
} from '@happier-dev/protocol';
import {
    compilePluginJsonSchema as canonicalCompilePluginJsonSchema,
    createPluginContributionIdentity as canonicalCreatePluginContributionIdentity,
    ingestPluginManifestV2 as canonicalIngestPluginManifest,
    isValidPluginJsonSchemaValue as canonicalIsValidPluginJsonSchemaValue,
} from '@happier-dev/protocol/plugins/manifest';
import { normalizeDetectedMcpServerV1 as canonicalNormalizeDetectedMcpServerV1 } from './mcp.js';
import {
    isRecord as canonicalIsRecord,
    parseJsonLine as canonicalParseJsonLine,
    parseTimestampMs as canonicalParseTimestampMs,
    readString as canonicalReadString,
    readTrimmedString as canonicalReadTrimmedString,
} from './sessions/fileStores/records.js';

type ProjectionTypes = [
    Disposable, JsonValue, PluginActivationModule, PluginApi, PluginCancellationOptions,
    PluginCleanup, PluginContributionRef, PluginDiagnosticData, PluginErrorData,
    PluginInvocationContext, LoggerService, PluginOperationAvailability, PluginPath,
    PluginReference, PluginServiceId, PluginServices,
    ActionContribution, ActionExecuteResult, ActionHandler, ActionSpec, ActionsService,
    CommandContribution, PluginActionInputById, PluginActionResultById, PluginInvocableActionId,
    ToolContribution, BackgroundServiceContext, BackgroundServiceContribution,
    BackgroundServiceDefinition, BackgroundServiceRunner, BackgroundServicesRegistrationApi,
    BrowserActionContribution, BrowserActionContributionInput, BrowserTargetContribution,
    BrowserTargetContributionInput, EventContribution, EventSubscriptionTarget, EventsService,
    HostEventEnvelope, HostEventId, HostEventPayloadById, HostEventScope, HostEventScopeById,
    HostEventTarget, HostEvents, PluginEventEmitResult, PluginEventEnvelope, PluginEventHandler,
    PluginEvents, PluginEventAutomationSetupResultV1,
    PluginEventAutomationHistoryGapResetActionInputV1,
    PluginEventAutomationHistoryGapResetActionResultV1,
    AgentCliReadinessService, ExecSpawnRequest, ExecService,
    PluginExecSpawnRequest, PluginProcessHandle, PluginProcessObservedTermination,
    PluginProcessOutput, PluginProcessResult, PluginProcessTerminationRequest, ResolvedSystemTool,
    SystemToolContribution, SystemToolDiagnostic, SystemToolResolveRequest, SystemToolsService,
    HttpMethod, HttpService, PluginFetchCredentialBinding,
    PluginWebSocketClose, PluginWebSocketConnection, PluginWebSocketHeader,
    PluginWebSocketMessage, PluginWebSocketOpenInput,
    ApprovalQueueListItem,
    ApprovalQueueQuery, ApprovalQueueRequest, ApprovalQueueRequestResult, ApprovalQueueService,
    ApprovalQueueSnapshot, ApprovalRequest, ApprovalRequestStatus, InteractionTerminalStatusV1,
    InteractionTransientApprovalAuthorRequestV1, InteractionTransientApprovalResultV1,
    InteractionTransientAuthorQuestionV1, InteractionTransientAuthorRequestV1,
    InteractionTransientChoiceSelectionV1, InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1, InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionsAuthorRequestV1, InteractionTransientQuestionsResultV1,
    InteractionTransientResultV1, InteractionOptions, InteractionSeverity, InteractionsService,
    PluginInvocationSurface, PresentationService, UiWidget,
    PluginContributes, PluginContributionIdentity, PluginManifest, DetectedMcpServerV1,
    McpAnnotations, McpBlobResourceContents, McpClient, McpDiscoveredEndpoint, McpDiscoveredServer,
    McpDiscoverySourceContribution, McpDiscoverySourceRef, McpDiscoveryRequest,
    McpDiscoveryResult, McpGetPromptResult, McpIcon, McpListToolsRequest,
    McpPageOptions, McpPrompt, McpPromptArgument, McpPromptContent, McpPromptMessage,
    McpPromptPage, McpReadResourceResult, McpResource, McpResourceContents, McpResourcePage,
    McpResourceTemplate, McpResourceTemplatePage, McpResourceUpdatedEvent, McpServerContribution,
    McpServerRef, McpServerRuntime, McpServerTransport, McpService, McpTextResourceContents, McpTool,
    McpToolCallContent, McpToolCallRequest, McpToolCallResult, McpToolPage, McpToolPageOptions,
    McpRegistrationApi,
    NotificationCategoryContribution, NotificationChannelContribution, NotificationPreferences,
    NotificationSendRequest, NotificationSendResult, NotificationSender, NotificationsService,
    PluginNotificationRegistrationApi, PluginResourceKind, PromptAssetAdapter,
    PromptAssetBundleRecord, PromptAssetCapabilities, PromptAssetContribution,
    PromptAssetDefaultRoot, PromptAssetDeleteRequest, PromptAssetDiscoverRequest,
    PromptAssetDiscoverResult, PromptAssetDiscoveryItem, PromptAssetDocRecord,
    PromptAssetExternalRef, PromptAssetInstallMode, PromptAssetLibraryKind,
    PromptAssetListTypesResult, PromptAssetMutationErrorCode, PromptAssetMutationPreview,
    PromptAssetMutationResult, PromptAssetReadRequest, PromptAssetReadResult, PromptAssetScope,
    PromptAssetSupportsScope, PromptAssetTypeDescriptor, PromptAssetWriteBundleRequest,
    PromptAssetWriteDocRequest, PromptAssetWriteRequest, PromptRegistryAdapterDescriptor,
    PromptRegistryConfiguredSource, PromptRegistryErrorCode, PromptRegistryErrorResult,
    PromptRegistryFetchItemRequest, PromptRegistryFetchItemResult, PromptRegistryFetchedItem,
    PromptRegistryInstallRequest, PromptRegistryInstallResult, PromptRegistryInstallTarget,
    PromptRegistryItemSummary, PromptRegistryListAdaptersResult,
    PromptRegistryListSourcesRequest, PromptRegistryListSourcesResult,
    PromptRegistryScanSourceRequest, PromptRegistryScanSourceResult,
    PromptRegistrySourceDescriptor, PromptRegistrySources, ResourceContribution,
    ResourceDescriptor, ResourcesService, SecretMutationResult,
    SecretStatus, SecretsService, SettingDescriptor, SettingField,
    PluginSettingsActionDeclaration, PluginSettingsActionInput, PluginSettingsActionResult,
    PluginSettingsActionRuntime<unknown>, SettingsChange, PluginSettingsContribution,
    SettingsService, AccountKvEntry, AccountKvListItem, AccountKvService, AccountKvTransaction,
    PluginAccountStorageScope, StorageConsistency, StorageScopeService, StorageService, StorageTransaction,
    DaemonDatabase, DaemonDatabaseExecutionResult,
    DaemonDatabaseIncumbentQueryFixture, DaemonDatabaseMigration,
    DaemonDatabaseMigrationDeclaration, DaemonDatabaseMigrationReadTransaction,
    DaemonDatabaseMigrationTransaction, DaemonDatabaseOperationOptions,
    DaemonDatabaseReadTransaction, DaemonDatabaseRow, DaemonDatabaseService,
    DaemonDatabaseStorageScope, DaemonDatabaseTransaction, DaemonDatabaseValue,
    AgentSessionRuntimeEventSubscriber,
    AgentSessionRuntimeEventValidationFailure, AgentSessionRuntimeHarness,
    PluginTestServicesFixture, PluginTestkit, PluginTestkitInvokeActionOptions, PluginTestkitOptions,
    PluginTestkitRegistration, PluginTestkitRegistrationByFamily, HostedWebBridgeEnvelopeV1,
    PluginUiChannel, PluginUiPlatform, RenderContext, RenderSurface, ResourceContent,
    SessionHeaderActionContribution, SurfaceContext,
    SurfaceHostMethod, UiRenderer, UiTranslationBundle, UiView,
];

function moduleExportNames(program: ts.Program, relativePath: string): readonly string[] {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!sourceFile) throw new Error(`Missing source module: ${relativePath}`);
    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
    return program.getTypeChecker().getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.name)
        .sort();
}

function createSdkProgram(): ts.Program {
    const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
    });
    if (!parsed) throw new Error(`Unable to parse ${configPath}`);
    return ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
    });
}

describe('final core-domain package-local projections', () => {
    it('keeps each final source projection on exactly one package-local owner', () => {
        const program = createSdkProgram();
        const expectedByOwner = {
            'src/exec.ts': [
                'AgentCliReadinessService',
                'ExecService',
                'ResolvedSystemTool',
                'SystemToolDiagnostic',
                'SystemToolResolveRequest',
                'SystemToolsService',
            ],
            'src/backgroundServices.ts': ['BackgroundServiceDefinition'],
            'src/browser/actions.ts': [
                'BrowserActionContribution',
                'BrowserActionContributionInput',
            ],
            'src/browser/targets.ts': [
                'BrowserTargetContribution',
                'BrowserTargetContributionInput',
            ],
            'src/events.ts': [
                'EventContribution',
                'PluginEventAutomationSetupResultV1',
                'PluginEventAutomationSetupResultV1Schema',
                'PluginEventAutomationHistoryGapResetActionInputV1',
                'PluginEventAutomationHistoryGapResetActionInputV1JsonSchema',
                'PluginEventAutomationHistoryGapResetActionInputV1Schema',
                'PluginEventAutomationHistoryGapResetActionResultV1',
                'PluginEventAutomationHistoryGapResetActionResultV1JsonSchema',
                'PluginEventAutomationHistoryGapResetActionResultV1Schema',
            ],
            'src/resources.ts': ['PromptAssetContribution'],
            'src/secrets.ts': [
                'SecretMutationResult',
                'SecretStatus',
                'SecretStringV1Schema',
                'SecretsService',
            ],
            'src/storage.ts': [
                'AccountKvEntry',
                'AccountKvListItem',
                'AccountKvService',
                'AccountKvTransaction',
                'PluginAccountStorageScope',
                'StorageConsistency',
                'StorageScopeService',
                'StorageService',
                'StorageTransaction',
            ],
            'src/storage/database.ts': [
                'DaemonDatabase',
                'DaemonDatabaseExecutionResult',
                'DaemonDatabaseIncumbentQueryFixture',
                'DaemonDatabaseMigration',
                'DaemonDatabaseMigrationDeclaration',
                'DaemonDatabaseMigrationReadTransaction',
                'DaemonDatabaseMigrationTransaction',
                'DaemonDatabaseOperationOptions',
                'DaemonDatabaseReadTransaction',
                'DaemonDatabaseRow',
                'DaemonDatabaseService',
                'DaemonDatabaseStorageScope',
                'DaemonDatabaseTransaction',
                'DaemonDatabaseValue',
            ],
        } as const;
        const losingByModule = {
            'src/services/index.ts': [
                'PluginExecService',
                'PluginSecretsService',
                'PluginStorageConsistency',
                'PluginStorageScopeService',
                'PluginStorageService',
                'PluginStorageTransaction',
            ],
            'src/runtime/index.ts': [
                'PluginExecService',
                'PluginSecretsService',
                'PluginStorageConsistency',
                'PluginStorageScopeService',
                'PluginStorageService',
                'PluginStorageTransaction',
            ],
            'src/services/io.ts': [
                'PluginAgentCliReadinessService',
                'PluginExecService',
                'PluginResolvedSystemTool',
                'PluginSystemToolDiagnostic',
                'PluginSystemToolResolveRequest',
                'PluginSystemToolsService',
            ],
            'src/definePlugin.ts': ['PluginBackgroundServiceDefinition'],
            'src/browser/actions.ts': [
                'PluginBrowserActionContributionInputV1',
                'PluginBrowserActionContributionV1',
            ],
            'src/browser/targets.ts': [
                'PluginBrowserTargetContributionInputV1',
                'PluginBrowserTargetContributionV1',
            ],
            'src/events.ts': ['PluginEventContributionV1'],
            'src/resources.ts': ['PluginPromptAssetContributionV1'],
            'src/services/core.ts': [
                'PluginSecretMutationResult',
                'PluginSecretStatus',
                'PluginSecretsService',
                'PluginStorageConsistency',
                'PluginStorageScopeService',
                'PluginStorageService',
                'PluginStorageTransaction',
            ],
        } as const;

        const finalAggregateNames = [
            'ExecService',
            'SecretsService',
            'AccountKvEntry',
            'AccountKvListItem',
            'AccountKvService',
            'AccountKvTransaction',
            'PluginAccountStorageScope',
            'StorageConsistency',
            'StorageScopeService',
            'StorageService',
            'StorageTransaction',
            'DaemonDatabase',
            'DaemonDatabaseExecutionResult',
            'DaemonDatabaseIncumbentQueryFixture',
            'DaemonDatabaseMigration',
            'DaemonDatabaseMigrationDeclaration',
            'DaemonDatabaseMigrationReadTransaction',
            'DaemonDatabaseMigrationTransaction',
            'DaemonDatabaseOperationOptions',
            'DaemonDatabaseReadTransaction',
            'DaemonDatabaseRow',
            'DaemonDatabaseService',
            'DaemonDatabaseStorageScope',
            'DaemonDatabaseTransaction',
            'DaemonDatabaseValue',
        ] as const;

        for (const [owner, expectedNames] of Object.entries(expectedByOwner)) {
            const exports = moduleExportNames(program, owner);
            expect(expectedNames.filter((name) => !exports.includes(name)), owner).toEqual([]);
        }
        for (const [losingModule, losingNames] of Object.entries(losingByModule)) {
            const exports = moduleExportNames(program, losingModule);
            expect(losingNames.filter((name) => exports.includes(name)), losingModule).toEqual([]);
        }
        for (const aggregate of ['src/services/index.ts', 'src/runtime/index.ts']) {
            const exports = moduleExportNames(program, aggregate);
            expect(finalAggregateNames.filter((name) => !exports.includes(name)), aggregate).toEqual([]);
        }
    }, 120_000);

    it('keeps every final type projection nameable without copying its owner', () => {
        expectTypeOf<ProjectionTypes>().toMatchTypeOf<readonly unknown[]>();
    });

    it('does not publish generic structured-message contribution aliases', () => {
        const program = createSdkProgram();

        expect(moduleExportNames(program, 'src/ui.ts')).not.toContain('StructuredMessageContribution');
        expect(moduleExportNames(program, 'src/ui/index.ts')).not.toContain('StructuredMessageContribution');
        // Same whole-SDK program as the projection test above, so it carries the
        // same budget. Measured 13.7 s alone and timing out against 30 s inside
        // `vitest run` for the package, where several whole-program suites share
        // the host.
    }, 120_000);

    it('preserves canonical runtime export identities', () => {
        expect(projectedGetActionSpec).toBe(canonicalGetActionSpec);
        expect(projectedCompilePluginJsonSchema).toBe(canonicalCompilePluginJsonSchema);
        expect(projectedCreatePluginContributionIdentity).toBe(canonicalCreatePluginContributionIdentity);
        expect(projectedParsePluginManifest({})).toEqual(canonicalIngestPluginManifest({}));
        expect(projectedIsValidPluginJsonSchemaValue).toBe(canonicalIsValidPluginJsonSchemaValue);
        expect(projectedIsRecord).toBe(canonicalIsRecord);
        expect(projectedParseJsonLine).toBe(canonicalParseJsonLine);
        expect(projectedParseTimestampMs).toBe(canonicalParseTimestampMs);
        expect(projectedReadString).toBe(canonicalReadString);
        expect(projectedReadTrimmedString).toBe(canonicalReadTrimmedString);
        expect(PluginEventAutomationSetupResultV1Schema)
            .toBe(canonicalPluginEventAutomationSetupResultV1Schema);
        expect(PluginEventAutomationHistoryGapResetActionInputV1Schema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema);
        expect(PluginEventAutomationHistoryGapResetActionInputV1JsonSchema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionInputV1JsonSchema);
        expect(PluginEventAutomationHistoryGapResetActionResultV1Schema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionResultV1Schema);
        expect(PluginEventAutomationHistoryGapResetActionResultV1JsonSchema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionResultV1JsonSchema);
        expect(PluginError.prototype).toBeInstanceOf(Error);
        expect(typeof definePlugin).toBe('function');
        expect(typeof defineBrowserAction).toBe('function');
        expect(typeof defineBrowserTarget).toBe('function');
        expect(normalizeDetectedMcpServerV1).toBe(canonicalNormalizeDetectedMcpServerV1);
        expect(typeof defineHostedWebBridgeMessage).toBe('function');
        expect(Array.isArray(BUILD_CONFIG_BASENAMES)).toBe(true);
        expect(typeof defineBuildConfig).toBe('function');
        expect(typeof createReactNativeRepackSharedModules).toBe('function');
        expect(typeof createReactNativeWebVitePlugins).toBe('function');
        expect(typeof defineReactNativeWebViteBuildPreset).toBe('function');
        expect(typeof createAgentSessionRuntimeHarness).toBe('function');
        expect(typeof createPluginTestkit).toBe('function');
    });
});
