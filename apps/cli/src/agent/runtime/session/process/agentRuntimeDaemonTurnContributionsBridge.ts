import type {
    AgentRuntimeDaemonTurnContributionsResultV1,
    ComposerStagedMediaAdmissionSettlementV1,
} from './agentRuntimeRunnerProtocol';
import type {
    ComposerAttachmentMessageAcceptedV1,
    ComposerAttachmentResolveRequestV1,
    ComposerAttachmentValueV1,
    ComposerReferenceResolutionV1,
    PluginContributionIdentityV1,
    SessionInputAdmissionResultV1,
    SessionPendingEnqueueByMachineRequestV1,
} from '@happier-dev/protocol';

type DaemonAgentRuntimePromptContributions = Extract<
    AgentRuntimeDaemonTurnContributionsResultV1,
    { kind: 'prompt' }
>;
type DaemonAgentRuntimeComposerReferenceContributions = Extract<
    AgentRuntimeDaemonTurnContributionsResultV1,
    { kind: 'composerReference' }
>;
type DaemonAgentRuntimeComposerAttachmentContributions = Extract<
    AgentRuntimeDaemonTurnContributionsResultV1,
    { kind: 'composerAttachment' }
>;
type DaemonAgentRuntimeAgentCompositionContributions = Extract<
    AgentRuntimeDaemonTurnContributionsResultV1,
    { kind: 'composition' }
>;

/**
 * Runner-side view of the strict daemon turn-contribution service channel.
 * This contract is independent of the retired whole-runtime session bridge.
 */
export type DaemonAgentRuntimeTurnContributionsBridge = Readonly<{
    admitSessionInput?(params: Readonly<{
        sessionId: string;
        request: SessionPendingEnqueueByMachineRequestV1;
        signal?: AbortSignal;
    }>): Promise<SessionInputAdmissionResultV1>;
    resolvePrompt(params: Readonly<{
        sessionId: string;
        selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
        machineId?: string;
        featureIds?: readonly string[];
        excludePluginIds?: readonly string[];
        signal?: AbortSignal;
    }>): Promise<DaemonAgentRuntimePromptContributions>;
    resolveAgentComposition(params: Readonly<{
        sessionId: string;
        runtimeFamily: 'hostSession' | 'acpSession';
        machineId?: string;
        featureIds?: readonly string[];
        signal?: AbortSignal;
    }>): Promise<DaemonAgentRuntimeAgentCompositionContributions>;
    resolveComposerReference(params: Readonly<{
        sessionId: string;
        reference: PluginContributionIdentityV1;
        candidateId: string;
        signal?: AbortSignal;
    }>): Promise<DaemonAgentRuntimeComposerReferenceContributions['resolution']>;
    resolveComposerAttachment(params: Readonly<{
        sessionId: string;
        attachment: PluginContributionIdentityV1;
        request: ComposerAttachmentResolveRequestV1<ComposerAttachmentValueV1>;
        signal?: AbortSignal;
    }>): Promise<DaemonAgentRuntimeComposerAttachmentContributions['result']>;
    afterComposerAttachmentMessageAccepted(params: Readonly<{
        sessionId: string;
        attachment: PluginContributionIdentityV1;
        event: ComposerAttachmentMessageAcceptedV1<ComposerAttachmentValueV1>;
        signal?: AbortSignal;
    }>): Promise<void>;
    settleComposerStagedMedia?(params: Readonly<{
        sessionId: string;
        outcome: 'accepted' | 'definitiveFailure';
        settlement: ComposerStagedMediaAdmissionSettlementV1;
        signal?: AbortSignal;
    }>): Promise<void>;
    transformAgentContext(params: Readonly<{
        sessionId: string;
        payload: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
    }>): Promise<Readonly<Record<string, unknown>>>;
    transformSessionInput(params: Readonly<{
        sessionId: string;
        payload: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
    }>): Promise<Readonly<Record<string, unknown>>>;
    transformAgentRequest(params: Readonly<{
        sessionId: string;
        payload: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
    }>): Promise<Readonly<Record<string, unknown>>>;
}>;
