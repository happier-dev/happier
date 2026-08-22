import { describe, expect, expectTypeOf, it } from 'vitest';

import * as protocol from './index.js';
import {
    ComposerReferenceCandidateIdV1Schema as canonicalComposerReferenceCandidateIdV1Schema,
} from './plugins/contributions/composerReferenceProviders.js';
import {
    COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1 as canonicalComposerControlStateContentType,
    ComposerControlStateContentTypeV1Schema as canonicalComposerControlStateContentTypeSchema,
} from './plugins/ui/composer.js';
import {
    buildComposerReferenceMentionPayloadV1 as canonicalBuildComposerReferenceMentionPayloadV1,
    readComposerReferenceMentionV1 as canonicalReadComposerReferenceMentionV1,
} from './runtime/input/composerReferenceProviderV1.js';
import {
    measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1 as canonicalMeasurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
    PluginCollectionCandidatePreparationRetireRequestV1Schema as canonicalPluginCollectionCandidatePreparationRetireRequestV1Schema,
    PluginCollectionCandidatePreparationStageRequestV1Schema as canonicalPluginCollectionCandidatePreparationStageRequestV1Schema,
    PluginCollectionContractReadResultV1Schema as canonicalPluginCollectionContractReadResultV1Schema,
    splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1 as canonicalSplitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1,
} from './plugins/data/collectionsV1.js';
import {
    PluginUiDestinationReferenceV1Schema as canonicalPluginUiDestinationReferenceV1Schema,
} from './plugins/ui/hostApiRequests.js';
import type {
    PluginUiDestinationRuntimeFormFactorV1 as CanonicalPluginUiDestinationRuntimeFormFactorV1,
} from './plugins/contributions/ui/surfaceRegistry.js';
import {
    PluginDeclarativeTargetedSurfaceNodeV2Schema as canonicalPluginDeclarativeTargetedSurfaceNodeV2Schema,
} from './plugins/contributions/ui/v2.js';
import {
    RETIRED_ACCOUNT_SETTINGS_SESSION_ONLY_KEYS as canonicalRetiredAccountSettingsSessionOnlyKeys,
    RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS as canonicalRetiredAccountSettingsSessionOrganizationKeys,
    SessionTmuxMachineOverrideSchema as canonicalSessionTmuxMachineOverrideSchema,
} from './account/settings/accountSettings.js';
import type {
    TranscriptMessageTimestampDisplayMode as CanonicalTranscriptMessageTimestampDisplayMode,
} from './account/settings/accountSettings.js';
import type { PluginConnectedAccountConfigurationFieldV2 } from './index.js';
import type { PluginConfigurationSettingFieldV2 } from './index.js';
import type { PluginUiViewV2Input } from './plugins/contributions/ui/v2.js';

// @ts-expect-error — retired author identity has no stable type export.
type RetiredExtensionId = import('./index.js').ExtensionId;
// @ts-expect-error — retired manifest author contract has no stable type export.
type RetiredExtensionManifest = import('./index.js').ExtensionManifestV2;
// @ts-expect-error — retired contribution union has no stable type export.
type RetiredExtensionContribution = import('./index.js').ExtensionContributionV2;
// @ts-expect-error — retired reload vocabulary has no stable type export.
type RetiredExtensionReload = import('./index.js').ExtensionReloadRequestV1;
// @ts-expect-error — static hook/export-name binding is retired from the public protocol ABI.
type RetiredHookRegistration = import('./index.js').HookRegistrationV1;
// @ts-expect-error — legacy Voice provider ids are parsed only at the compatibility ingress.
type LegacyVoiceProviderId = import('./index.js').VoiceProviderId;
void (null as unknown as RetiredExtensionId);
void (null as unknown as RetiredExtensionManifest);
void (null as unknown as RetiredExtensionContribution);
void (null as unknown as RetiredExtensionReload);
void (null as unknown as RetiredHookRegistration);
void (null as unknown as LegacyVoiceProviderId);

if (false) {
    const retainedAppPageInput = {
        id: 'retained-app-page',
        container: 'appPage',
        target: { kind: 'app' },
        renderer: 'retained-renderer',
    } satisfies PluginUiViewV2Input;
    const retainedAppRightSidebarInput = {
        id: 'retained-app-right-sidebar',
        container: 'rightSidebarTab',
        target: { kind: 'app' },
        renderer: 'retained-renderer',
    } satisfies PluginUiViewV2Input;
    const retainedSessionRightPaneInput = {
        id: 'retained-session-right-pane',
        container: 'rightPane',
        target: { kind: 'session' },
        renderer: 'retained-renderer',
    } satisfies PluginUiViewV2Input;
    const retainedProjectDetailsPaneInput = {
        id: 'retained-project-details-pane',
        container: 'detailsPane',
        target: { kind: 'project' },
        renderer: 'retained-renderer',
    } satisfies PluginUiViewV2Input;

    // @ts-expect-error rightPane has no App target binding.
    const rejectedAppRightPaneInput: PluginUiViewV2Input = {
        id: 'rejected-app-right-pane',
        container: 'rightPane',
        target: { kind: 'app' },
        renderer: 'retained-renderer',
    };
    // @ts-expect-error detailsPane has no App target binding.
    const rejectedAppDetailsPaneInput: PluginUiViewV2Input = {
        id: 'rejected-app-details-pane',
        container: 'detailsPane',
        target: { kind: 'app' },
        renderer: 'retained-renderer',
    };
    // @ts-expect-error bottomPane has no App target binding.
    const rejectedAppBottomPaneInput: PluginUiViewV2Input = {
        id: 'rejected-app-bottom-pane',
        container: 'bottomPane',
        target: { kind: 'app' },
        renderer: 'retained-renderer',
    };

    void [
        retainedAppPageInput,
        retainedAppRightSidebarInput,
        retainedSessionRightPaneInput,
        retainedProjectDetailsPaneInput,
        rejectedAppRightPaneInput,
        rejectedAppDetailsPaneInput,
        rejectedAppBottomPaneInput,
    ];
}

describe('protocol package root exports', () => {
    it('exports the canonical Account Settings retirement lists through the package root', () => {
        expect(protocol.RETIRED_ACCOUNT_SETTINGS_SESSION_ONLY_KEYS)
            .toBe(canonicalRetiredAccountSettingsSessionOnlyKeys);
        expect(protocol.RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS)
            .toBe(canonicalRetiredAccountSettingsSessionOrganizationKeys);
        expect(protocol.RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS)
            .toContain('sessionFoldersV1');
    });

    it('exports the canonical Session tmux machine-override schema through the package root', () => {
        expect(protocol.SessionTmuxMachineOverrideSchema)
            .toBe(canonicalSessionTmuxMachineOverrideSchema);
    });

    it('exports the canonical plugin Collection contract reader through the package root', () => {
        expect(protocol.PluginCollectionContractReadResultV1Schema)
            .toBe(canonicalPluginCollectionContractReadResultV1Schema);
        expectTypeOf<protocol.PluginCollectionContractReadResultV1>().not.toBeNever();
    });

    it('exports the canonical host-owned Collection candidate-preparation stage and retire wires', () => {
        expect(protocol.PluginCollectionCandidatePreparationStageRequestV1Schema)
            .toBe(canonicalPluginCollectionCandidatePreparationStageRequestV1Schema);
        expectTypeOf<protocol.PluginCollectionCandidatePreparationStageRequestV1>().not.toBeNever();
        expect(protocol.measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1)
            .toBe(canonicalMeasurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1);
        expect(protocol.splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1)
            .toBe(canonicalSplitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1);
        expect(protocol.PluginCollectionCandidatePreparationRetireRequestV1Schema)
            .toBe(canonicalPluginCollectionCandidatePreparationRetireRequestV1Schema);
        expectTypeOf<protocol.PluginCollectionCandidatePreparationRetireRequestV1>().not.toBeNever();
    });

    it('exports the canonical plugin UI destination reference through the package root', () => {
        expect(protocol.PluginUiDestinationReferenceV1Schema)
            .toBe(canonicalPluginUiDestinationReferenceV1Schema);
        expectTypeOf<protocol.PluginUiDestinationReferenceV1>().not.toBeNever();
    });

    it('exports the canonical UI form-factor and transcript timestamp types through the package root', () => {
        expectTypeOf<protocol.PluginUiDestinationRuntimeFormFactorV1>()
            .toEqualTypeOf<CanonicalPluginUiDestinationRuntimeFormFactorV1>();
        expectTypeOf<protocol.TranscriptMessageTimestampDisplayMode>()
            .toEqualTypeOf<CanonicalTranscriptMessageTimestampDisplayMode>();
    });

    it('exports the canonical symbolic targeted Surface node schema through the package root', () => {
        expect(protocol.PluginDeclarativeTargetedSurfaceNodeV2Schema)
            .toBe(canonicalPluginDeclarativeTargetedSurfaceNodeV2Schema);
        expectTypeOf<protocol.PluginDeclarativeTargetedSurfaceNodeV2>().not.toBeNever();
    });

    it('exports the canonical composer reference candidate-id schema', () => {
        expect(protocol.ComposerReferenceCandidateIdV1Schema)
            .toBe(canonicalComposerReferenceCandidateIdV1Schema);
        expect(protocol.ComposerReferenceCandidateIdV1Schema.safeParse('candidate-1').success)
            .toBe(true);
    });

    it('exports the exact Composer control-state Resource media type', () => {
        expect(protocol.COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1)
            .toBe(canonicalComposerControlStateContentType);
        expect(protocol.ComposerControlStateContentTypeV1Schema)
            .toBe(canonicalComposerControlStateContentTypeSchema);
    });

    it('exports only the direct-cut composer-reference mention helpers', () => {
        expect(protocol.buildComposerReferenceMentionPayloadV1)
            .toBe(canonicalBuildComposerReferenceMentionPayloadV1);
        expect(protocol.readComposerReferenceMentionV1)
            .toBe(canonicalReadComposerReferenceMentionV1);
        expect(protocol).not.toHaveProperty('buildComposerReferenceProviderMentionPayloadV1');
        expect(protocol).not.toHaveProperty('readComposerReferenceProviderMentionV1');
    });

    it('keeps the legacy Voice provider-id parser out of the public root', () => {
        expect(protocol).not.toHaveProperty('VoiceProviderIdSchema');
    });

    it('exports the canonical Voice speech endpoint-policy owner', () => {
        expect(protocol.resolveVoiceSpeechEndpointPolicy({
            settings: {
                baseUrl: 'http://localhost:11434/v1',
                insecureLocalOriginConsent: 'http://localhost:11434',
                insecureLocalConsentMachineId: 'machine-a',
            },
            machineId: 'machine-a',
        })).toEqual({
            normalizedBaseUrl: 'http://localhost:11434/v1',
            origin: 'http://localhost:11434',
            insecureHttpConfirmed: true,
        });
    });

    it('does not expose the retired Extension author/runtime vocabulary', () => {
        const retired = Object.keys(protocol).filter((name) => (
            name.startsWith('Extension')
            || name.startsWith('getExtension')
            || name === 'encodeExtensionIdForFilesystem'
        ));

        expect(retired).toEqual([]);
    });

    it('exports the canonical Pending requested-action contract', () => {
        expectTypeOf<protocol.PendingRequestedActionV1>().not.toBeNever();
        expect(protocol.PendingRequestedActionV1Schema.parse({ v: 1, kind: 'send_now' }))
            .toEqual({ v: 1, kind: 'send_now' });
    });

    it('exports the canonical Automation template envelope contract', () => {
        expect(protocol.AutomationTemplateEnvelopeSchema.parse({
            kind: protocol.AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
            payload: { directory: '/repo' },
        })).toEqual({
            kind: 'happier_automation_template_plain_v1',
            payload: { directory: '/repo' },
        });
    });

    it('exports canonical Automation event admission and occurrence contracts', () => {
        expect(typeof protocol.deriveAutomationOccurrenceKeyV1).toBe('function');
        expect(typeof protocol.AutomationEventAdmitInputV1Schema.safeParse).toBe('function');
        expect(typeof protocol.AutomationEventSourcesListInputV1Schema.safeParse).toBe('function');
        expect(typeof protocol.AutomationEventSourceStatusReportV1Schema.safeParse).toBe('function');
        expect(typeof protocol.PluginEventAutomationDeclarationV1Schema.safeParse).toBe('function');
    });

    it('exports the canonical Action confirmation-presentation owner', () => {
        const requiresConfirmationPresentation = (
            protocol as {
                pluginActionRequiresConfirmationPresentation?: (
                    surfaces: readonly ('cli' | 'mcp' | 'plugin' | 'ui')[],
                    dangerLevel: 'safe' | 'writesLocal' | 'writesRemote' | 'externalSideEffect' | 'destructive',
                ) => boolean;
            }
        ).pluginActionRequiresConfirmationPresentation;

        expect(requiresConfirmationPresentation).toBeTypeOf('function');
        expect(requiresConfirmationPresentation?.(['plugin'], 'writesRemote')).toBe(false);
        expect(requiresConfirmationPresentation?.(['cli'], 'writesRemote')).toBe(true);
    });

    it('initializes the portable materialization-ref owner through the package root', () => {
        expect(protocol.PluginMachineMaterializationRefV1Schema.parse({
            machineId: 'machine-a',
            materializationId: 'install-epoch-a',
            pluginId: 'com.acme.fixture',
        })).toEqual({
            machineId: 'machine-a',
            materializationId: 'install-epoch-a',
            pluginId: 'com.acme.fixture',
        });
    });

    it('exports the strict Session metadata privacy contracts', () => {
        expectTypeOf<protocol.SessionOwnerMetadataEnvelopeV1>().not.toBeNever();
        expectTypeOf<
            Extract<
                protocol.SessionOwnerMetadataEnvelopeV1,
                { t: 'plain' }
            >['v']
        >().toEqualTypeOf<protocol.SessionOwnerMetadataV1>();
        expect(typeof protocol.SessionOwnerMetadataEnvelopeV1Schema.safeParse)
            .toBe('function');
        expect(typeof protocol.createPlainSessionOwnerMetadataEnvelopeV1)
            .toBe('function');
        expect(typeof protocol.encodeSessionOwnerMetadataEnvelopeV1)
            .toBe('function');
        expect(typeof protocol.parseSessionOwnerMetadataEnvelopeV1)
            .toBe('function');
        expect(typeof protocol.sealSessionOwnerMetadataEnvelopeV1)
            .toBe('function');
        expect(typeof protocol.openSessionOwnerMetadataEnvelopeV1)
            .toBe('function');
        expect(typeof protocol.validateSessionOwnerMetadataEnvelopeForAccountModeV1)
            .toBe('function');
        expect(typeof protocol.SessionMetadataEnvelopeTupleV1Schema.safeParse)
            .toBe('function');
        expect(typeof protocol.SessionMetadataTuplePatchV1Schema.safeParse)
            .toBe('function');
        expect(typeof protocol.SessionMetadataTuplePatchSuccessV1Schema.safeParse)
            .toBe('function');
        expect(typeof protocol.SessionMetadataRecipientProjectionV1Schema.safeParse)
            .toBe('function');
        expect(typeof protocol.SessionMetadataVersionConflictV1Schema.safeParse)
            .toBe('function');
        expect(typeof protocol.SessionMetadataActiveConflictV1Schema.safeParse)
            .toBe('function');
        expect(
            typeof protocol.SessionMetadataInactiveModelIntentExpectationV1Schema
                .safeParse,
        ).toBe('function');
        expect(
            typeof protocol.SessionMetadataInactiveModelIntentPatchV1Schema
                .safeParse,
        ).toBe('function');
        expect(
            typeof protocol
                .SessionMetadataInactiveModelIntentOwnerPatchV1Schema.safeParse,
        ).toBe('function');
        expect(
            typeof protocol
                .SessionMetadataInactiveModelIntentPatchSuccessV1Schema
                .safeParse,
        ).toBe('function');
        expect(
            typeof protocol
                .SessionMetadataInactiveModelIntentVersionConflictV1Schema
                .safeParse,
        ).toBe('function');
        expect(typeof protocol.SessionOwnerCompatibilityViewV1Schema.safeParse)
            .toBe('function');
        expect(typeof protocol.projectSessionOwnerCompatibilityViewV1)
            .toBe('function');
        expect(
            typeof protocol.AccountEncryptionMigrateTransitionPrepareRequestSchema
                .safeParse,
        ).toBe('function');
        expect(
            typeof protocol.AccountEncryptionMigrateCollectionStageBatchRequestSchema
                .safeParse,
        ).toBe('function');
        expect(
            typeof protocol.AccountEncryptionMigrateTransitionActivateRequestSchema
                .safeParse,
        ).toBe('function');
        expect(protocol).not.toHaveProperty(
            'AccountEncryptionMigratePrepareBatchRequestSchema',
        );
        expect(protocol).not.toHaveProperty(
            'AccountEncryptionMigrateRotationStateV1Schema',
        );
    });

    it('exports the canonical Connected Account configuration field contract', () => {
        expectTypeOf<PluginConfigurationSettingFieldV2>().toMatchTypeOf<{
            id: string;
            secret?: boolean;
            required?: boolean;
        }>();
        expectTypeOf<PluginConnectedAccountConfigurationFieldV2['semantic']>()
            .toEqualTypeOf<'connectedAccountOrigin' | undefined>();
        expect(protocol.PluginConfigurationSettingFieldV2Schema.parse({
            id: 'baseUrl',
            title: 'Base URL',
            schema: { type: 'string' },
            required: true,
        })).toMatchObject({
            id: 'baseUrl',
            required: true,
        });
        expect(protocol.PluginConnectedAccountConfigurationFieldV2Schema.parse({
            id: 'api-origin',
            title: 'API origin',
            semantic: 'connectedAccountOrigin',
            required: true,
            schema: { type: 'string', minLength: 1 },
        })).toMatchObject({
            id: 'api-origin',
            semantic: 'connectedAccountOrigin',
            secret: false,
            required: true,
        });
    });

    it('exports the canonical own-record reader for provider consumers', () => {
        expect(typeof (protocol as any).readOwnRecordValue).toBe('function');
        const inherited = Object.create({ inherited: 'must-not-read' }) as Record<string, string>;
        inherited.own = 'value';
        expect((protocol as any).readOwnRecordValue(inherited, 'own')).toBe('value');
        expect((protocol as any).readOwnRecordValue(inherited, 'inherited')).toBeUndefined();
    });

    it('exports the historical built-in launch-profile projector used by CLI account settings', () => {
        expect(typeof (protocol as any).projectHistoricalBuiltInAiLaunchProfileV1).toBe('function');
    });

    it('exports scm commit limits and operation codes for CLI consumers', () => {
        expect(protocol.SCM_COMMIT_MESSAGE_MAX_LENGTH).toBe(4096);
        expect(protocol.SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY).toBe('NOT_REPOSITORY');
        expect(typeof protocol.evaluateScmRemoteMutationPolicy).toBe('function');
        expect(typeof protocol.inferScmRemoteTarget).toBe('function');
        expect(typeof protocol.mapGitScmErrorCode).toBe('function');
        expect(typeof protocol.mapSaplingScmErrorCode).toBe('function');
        expect(typeof protocol.normalizeScmRemoteRequest).toBe('function');
    });

    it('exports SCM pull-request protocol schemas for downstream packets', () => {
        expect(typeof (protocol as any).ScmFollowupActionSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmPullRequestReferenceSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmPullRequestRunStackedResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmHostingProviderKindSchema?.safeParse).toBe('function');
        expect((protocol as any).ScmDefaultBranchPushPolicySchema.parse('requires-feature-branch'))
            .toBe('requires-feature-branch');
    });

    it('exports SCM repository provisioning protocol schemas for downstream packets', () => {
        expect(typeof (protocol as any).ScmRepositoryInitRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmRepositoryRemoveIndexLockRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmRepositoryProvisioningFailureResponseSchema?.safeParse)
            .toBe('function');
        expect(typeof (protocol as any).ScmRepositoryCloneInputSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmRepositoryCloneOutputSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SourceControlCloneProtocolSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmHostingRepositoryPublishRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmHostingRepositoryPublishResponseSchema?.safeParse).toBe('function');
    });

    it('exports SCM diff-summary cache and selector protocol schemas for downstream packets', () => {
        expect((protocol as any).SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION).toBe(1);
        expect(typeof (protocol as any).ScmDiffSummaryCacheEntrySchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmDiffSummaryCacheKeyDescriptorSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmDiffSummaryCachePolicySchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmDiffSummaryCostMetadataSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmDiffSummaryGenerationStateSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmDiffSummaryResolvedSelectorSchema?.safeParse).toBe('function');
    });

    it('exports automation change/update schemas through root exports', () => {
        expect(protocol.ChangeKindSchema.parse('automation')).toBe('automation');
        const parsed = protocol.UpdateBodySchema.parse({
            t: 'automation-upsert',
            automationId: 'auto_1',
            version: 1,
            enabled: true,
            updatedAt: Date.now(),
        });
        expect(parsed.t).toBe('automation-upsert');
    });

    it('exports execution run streaming schemas', () => {
        expect(typeof (protocol as any).ExecutionRunTurnStreamStartRequestSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunTurnStreamReadResponseSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunTurnStreamCancelRequestSchema).toBe('object');
    });

    it('exports session transcript and events action input schemas', () => {
        expect(typeof (protocol as any).SessionTranscriptGetInputSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionEventsGetInputSchema?.safeParse).toBe('function');
    });

    it('exports review triage overlay schemas for execution-run consumers', () => {
        expect(typeof (protocol as any).ReviewTriageOverlaySchema?.safeParse).toBe('function');
        const parsed = (protocol as any).ReviewTriageOverlaySchema.safeParse({
            findings: [{ id: 'f1', status: 'accept' }],
        });
        expect(parsed.success).toBe(true);
    });

    it('exports bug report routing defaults', () => {
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_OWNER).toBe('happier-dev');
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_REPO).toBe('happier');
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_LABELS).toEqual(['bug']);
        expect(typeof protocol.normalizeBugReportProviderUrl).toBe('function');
        expect(typeof protocol.normalizeBugReportIssueSlug).toBe('function');
        expect(typeof protocol.resolveBugReportServerDiagnosticsLines).toBe('function');
        expect(typeof protocol.searchBugReportSimilarIssues).toBe('function');

        const url = protocol.buildBugReportFallbackIssueUrl({
            title: 'Example',
            body: 'Body',
            owner: '',
            repo: '',
        });
        expect(url).toContain('https://github.com/happier-dev/happier/issues/new?');
    });

    it('exports browser automation and recording capability contracts', () => {
        expect(typeof (protocol as any).BrowserAutomationCapabilitiesSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).BrowserAutomationEvalCapabilitiesSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).BrowserAutomationInjectedPageCapabilitiesSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).BrowserAutomationTimelineCapabilitiesSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).BrowserRecordingCapabilitiesSchema?.safeParse).toBe('function');
        expect((protocol as any).DEFAULT_BROWSER_AUTOMATION_CAPABILITIES.enabled).toBe(false);
        expect((protocol as any).DEFAULT_BROWSER_RECORDING_CAPABILITIES.enabled).toBe(false);
    });

    it('exports daemon execution run schemas for machine-wide run listing', () => {
        expect(typeof (protocol as any).DaemonExecutionRunMarkerSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonExecutionRunListResponseSchema?.safeParse).toBe('function');
    });

    it('exports daemon terminal schemas for embedded terminal surfaces', () => {
        expect(typeof (protocol as any).DaemonTerminalEnsureRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonTerminalStreamReadResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonTerminalStreamEventSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).TerminalStreamBytesFrameSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).TerminalStreamReadRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).TerminalInputEventSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).terminalInputEventToPtyAction).toBe('function');
    });

    it('exports daemon MCP servers schemas', () => {
        expect(typeof (protocol as any).DaemonMcpServersTestRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonMcpServersTestResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonMcpServersDetectRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonMcpServersDetectResponseSchema?.safeParse).toBe('function');
    });

    it('exports daemon voice inference schemas', () => {
        expect(typeof (protocol as any).DaemonVoiceInferenceStatusRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceTtsSynthesizeRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceModelsWarmRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceTtsChunkRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceTtsFinalizeRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttUploadInitRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttUploadFinalizeResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttTranscribeRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttStreamStartRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttStreamChunkRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttStreamFinishRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttStreamCancelRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ModelPackManifestSchema?.safeParse).toBe('function');
    });

    it('exports session folder schemas', () => {
        expect(typeof (protocol as any).SessionFoldersV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionFolderWorkspaceRefV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SetSessionFolderAssignmentRequestSchema?.safeParse).toBe('function');
    });

    it('exports session organization schemas', () => {
        expect(typeof (protocol as any).SessionOrganizationSnapshotRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationSnapshotResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationPinSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationFolderSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationTagSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationOrderEntrySchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationLabelSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SetSessionPinRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ReorderSessionOrganizationRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).CreateOrUpdateSessionOrganizationFolderRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DeleteSessionOrganizationFolderRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).CreateOrUpdateSessionOrganizationTagRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DeleteSessionOrganizationTagRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SetSessionTagAssignmentsRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).UpsertSessionOrganizationLabelRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DeleteSessionOrganizationLabelRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ImportLegacySessionOrganizationRequestSchema?.safeParse).toBe('function');
    });

    it('exports pet package and daemon RPC schemas', () => {
        expect((protocol as any).PET_ATLAS_V1?.width).toBe(1536);
        expect(typeof (protocol as any).PetPackageManifestV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).PetPackageSourceV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonPetDiscoverRequestV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonPetImportResponseV1Schema?.safeParse).toBe('function');
    });

    it('exports external-session daemon RPC schemas', () => {
        expect(typeof (protocol as any).ExternalSessionsAgentIdSchema?.safeParse).toBe('function');
        expect((protocol as any).ExternalSessionsAgentIdSchema.parse('codex')).toBe('codex');
        expect((protocol as any).ExternalSessionsAgentIdSchema.parse('claude')).toBe('claude');
        expect((protocol as any).ExternalSessionsAgentIdSchema.parse('opencode')).toBe('opencode');
        expect((protocol as any).ExternalSessionsAgentIdSchema.parse('ohMyPi')).toBe('ohMyPi');
        expect((protocol as any).EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1.claudeConfig).toEqual(['claude']);
        expect(typeof (protocol as any).ExternalSessionsCandidatesListRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ExternalSessionTranscriptPageRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ExternalSessionTranscriptReadAfterRequestSchema?.safeParse).toBe('function');
        expect((protocol as any).DirectTranscriptPageRequestSchema).toBeUndefined();
        expect((protocol as any).DirectTranscriptReadAfterRequestSchema).toBeUndefined();
        expect(typeof (protocol as any).ExternalSessionLinkEnsureRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ExternalSessionFollowPolicySetRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ExternalSessionTakeoverRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ExternalSessionTakeoverPersistRequestSchema?.safeParse).toBe('function');
    });

    it('does not export Codex app-server goal provider helpers from the root protocol ABI', () => {
        expect((protocol as any).CodexAppServerGoalSchema).toBeUndefined();
        expect((protocol as any).CodexAppServerGoalStatusSchema).toBeUndefined();
        expect((protocol as any).normalizeCodexAppServerGoalToSessionWorkStateItem).toBeUndefined();
    });

    it('exports the canonical action id family catalog', () => {
        expect((protocol as any).ACTION_ID_FAMILIES_V1.intent_start).toEqual([
            'review.start',
            'subagents.plan.start',
            'subagents.delegate.start',
            'voice_agent.start',
        ]);
        expect((protocol as any).ACTION_IDS).toContain('approval.request.create');
    });

    it('exports session handoff schemas', () => {
        expect(typeof (protocol as any).SessionHandoffStartRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionHandoffPrepareTargetRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionHandoffStatusSchema?.safeParse).toBe('function');
        expect((protocol as any).SESSION_HANDOFF_PROGRESS_TIMELINES_V1.full).toEqual([
            'plan',
            'transfer_blobs',
            'stage_target',
            'apply',
            'import_session',
            'finalize',
        ]);
        expect(typeof (protocol as any).TransferChunkEnvelopeSchema?.safeParse).toBe('function');
        expect(Array.isArray((protocol as any).transferChunkEncryptionVectors)).toBe(true);
        expect(typeof (protocol as any).createDeterministicRandomBytesFromBase64).toBe('function');
    });

    it('does not export the legacy continue-with-replay compat ingress parser from the root ABI', () => {
        expect((protocol as any).parseSessionContinueWithReplayRpcParamsCompatIngress).toBeUndefined();
        expect(typeof (protocol as any).SessionContinueWithReplayRpcParamsSchema?.safeParse).toBe('function');
    });

    it('does not export the removed sync-only workspace replication RPC surface', () => {
        expect((protocol as any).WorkspaceReplicationEndpointSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationDiffSummarySchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationRemoteStagingModeSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationOperationIdSchema).toBeUndefined();
        expect((protocol as any).WorkspaceSyncModeSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationScanRequestSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationDiffResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationBaselineReadResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationStageRequestSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationApplyResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationCommitResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationAbortRequestSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationCoordinatorDiagnosticReasonSchema).toBeUndefined();
    });

    it('exports connected service profile id schema', () => {
        expect(protocol.ConnectedServiceProfileIdSchema.parse('work')).toBe('work');
    });

    it('exports account encryption migrate schemas', () => {
        expect(protocol.AccountEncryptionMigrateInvalidParamsReasonSchema.parse('restore_required')).toBe('restore_required');
        const parsed = protocol.AccountEncryptionMigrateBadRequestResponseSchema.parse({
            error: 'invalid-params',
            reason: 'key_proof_required',
        });
        expect(parsed.error).toBe('invalid-params');
    });

    it('exports backend profile schemas and helpers', () => {
        expect(typeof (protocol as any).AIBackendProfileSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SavedSecretSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).getBuiltInBackendProfile).toBe('function');
        expect(Array.isArray((protocol as any).DEFAULT_BUILT_IN_BACKEND_PROFILES)).toBe(true);
        expect(typeof (protocol as any).resolveBackendProfile).toBe('function');
        expect(typeof (protocol as any).isProfileCompatibleWithAgent).toBe('function');
        expect(typeof (protocol as any).getRequiredSecretEnvVarNames).toBe('function');
        expect(typeof (protocol as any).getRequiredConfigEnvVarNames).toBe('function');
        expect(typeof (protocol as any).getMissingRequiredConfigEnvVarNames).toBe('function');
        expect(typeof (protocol as any).getProfileEnvironmentVariables).toBe('function');
    });

    it('exports ACP catalog settings schemas', () => {
        expect(typeof (protocol as any).AcpCatalogSettingsV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).AcpBackendDefinitionV1Schema?.safeParse).toBe('function');
    });

    it('exports the generated plugin UI artifact manifest owner', () => {
        expect(typeof (protocol as any).PluginUiArtifactsManifestV1Schema?.safeParse).toBe('function');
    });

    it('exports Live Activity remote update schemas', () => {
        expect((protocol as any).HAPPIER_FOCUS_LIVE_ACTIVITY_NAME).toBe('HappierFocusLiveActivity');
        expect(typeof (protocol as any).LiveActivityRemoteUpdateRequestV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).HappierFocusLiveActivityContentStateV1Schema?.safeParse).toBe('function');
        expect((protocol as any).LiveActivityRemoteTargetKindSchema.parse('expo_push_token')).toBe('expo_push_token');
        expect((protocol as any).LiveActivityRemoteTargetKindSchema.parse('activitykit_update_token'))
            .toBe('activitykit_update_token');
        expect(typeof (protocol as any).classifyLiveActivityApnsDeliveryResponse).toBe('function');
        expect(typeof (protocol as any).buildLiveActivityRemoteUpdateCapabilityDiagnostics).toBe('function');
        expect(typeof (protocol as any).resolveLiveActivityRemoteUpdateMode).toBe('function');
        expect((protocol as any).classifyLiveActivityApnsDeliveryResponse({
            status: 410,
            reason: 'Unregistered',
        })).toEqual({
            action: 'permanent_drop_target',
            reason: 'Unregistered',
        });
        expect((protocol as any).deriveLiveActivityApnsDeliveryFields({
            bundleId: 'dev.happier.app',
            activityId: 'activity-1',
            event: 'update',
            template: 'quietFocus',
            nowEpochSeconds: 1_000,
            quietHoursActive: false,
            alertRequested: true,
        }).priority).toBe(5);
    });

    it('exports configured ACP backend legacy aliases', () => {
        expect(typeof (protocol as any).AcpConfiguredBackendV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).buildAcpConfiguredBackendV1).toBe('function');
        expect(typeof (protocol as any).readAcpConfiguredBackendV1FromMetadata).toBe('function');
        expect(typeof (protocol as any).isLegacyConfiguredAcpFlavorCarrier).toBe('function');
    });

    it('keeps the agent-prefixed runtime-descriptor aliases out of the root export surface', () => {
        expect((protocol as any).AgentRuntimeDescriptorV1Schema).toBeUndefined();
        expect((protocol as any).readAgentRuntimeDescriptorV1).toBeUndefined();
        expect(typeof (protocol as any).LegacyAgentRuntimeDescriptorV1Schema?.safeParse).toBe('function');
        expect((protocol as any).readLegacyAgentRuntimeDescriptorV1).toBeUndefined();
        expect((protocol as any).readLegacyAgentRuntimeDescriptorV1FromMetadata).toBeUndefined();
        expect((protocol as any).readLegacyAgentRuntimeDescriptorV1ForProvider).toBeUndefined();
    });

    it('exports backend target schemas and helpers', () => {
        expect(typeof (protocol as any).BackendTargetRefSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).buildBackendTargetKey).toBe('function');
        expect((protocol as any).buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review' })).toBe('acpBackend:review');
    });

    it('keeps the retired static hook binding contract out of the root export surface', () => {
        expect((protocol as any).HookHandlerTargetsV1).toBeUndefined();
        expect((protocol as any).HookHandlerTargetV1Schema).toBeUndefined();
        expect((protocol as any).HookHandlerRefV1Schema).toBeUndefined();
        expect((protocol as any).HookRegistrationV1Schema).toBeUndefined();
        expect((protocol as any).isHookHandlerTargetV1).toBeUndefined();
        expect((protocol as any).readHookRegistrationV1).toBeUndefined();
    });
});
