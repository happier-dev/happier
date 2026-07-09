import type {
    AcpAuthoringServiceV1,
    AgentsRuntimeServiceV1,
    PluginContextV1,
    ProviderAccountUsageRuntimeServiceV1,
} from './context.js';
import type { ExecRuntimeServiceV1 } from './exec.js';
import type { PluginReviewCommentsServiceV1 } from './reviews/comments.js';
import type { SessionPermissionsServiceV1, SessionProviderAcceptedUserMessageDeliveryQueryV1 } from './sessions/index.js';
import type { SessionHooksRuntimeServiceV1 } from './sessionHooks.js';
import type { TerminalHostRuntimeServiceV1 } from './terminalHost.js';
import type { TranscriptFileFollowRuntimeServiceV1, TranscriptsRuntimeServiceV1 } from './transcripts.js';

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type IsUnknown<T> = unknown extends T
    ? ([keyof T] extends [never] ? true : false)
    : false;

type _PluginContextMustExposePermissionsFacet = AssertTrue<
    PluginContextV1['permissions'] extends Readonly<{
        isGranted(id: string): boolean;
        list(): readonly string[];
    }> ? true : false
>;

type _PluginContextMustExposeCurrentSessionPermissions = AssertTrue<
    PluginContextV1['sessions']['current'] extends Readonly<{
        permissions: SessionPermissionsServiceV1;
    }> ? true : false
>;

type _PluginContextMayExposeProviderAcceptedUserMessageDeliveryQuery = AssertTrue<
    PluginContextV1['sessions']['current'] extends Readonly<{
        hasProviderAcceptedUserMessageDelivery?: (
            query: SessionProviderAcceptedUserMessageDeliveryQueryV1,
        ) => boolean;
    }> ? true : false
>;

type _PluginContextMustExposeExplicitSessionPermissions = AssertTrue<
    PluginContextV1['sessions']['permissions'] extends Readonly<{
        forSession(sessionId: string): Promise<SessionPermissionsServiceV1 | null>;
    }> ? true : false
>;

type UntargetedSessionsPermissionKeys = Extract<
    keyof PluginContextV1['sessions']['permissions'],
    keyof SessionPermissionsServiceV1
>;

type _PluginContextSessionsPermissionsMustBeExplicitlyTargeted =
    AssertNever<UntargetedSessionsPermissionKeys>;

type _PluginContextMustExposeActionApprovals = AssertTrue<
    Extract<keyof PluginContextV1['actions']['approvals'], 'request'> extends 'request' ? true : false
>;

type _PluginContextActionsMustNotExposeBrowserRuntime = AssertTrue<
    Extract<keyof PluginContextV1['actions'], 'browser'> extends never ? true : false
>;

type _PluginContextActionsMustNotExposeLocalServicesRuntime = AssertTrue<
    Extract<keyof PluginContextV1['actions'], 'localServices'> extends never ? true : false
>;

type _PluginContextActionsMustNotExposeSimulatorRuntime = AssertTrue<
    Extract<keyof PluginContextV1['actions'], 'devices'> extends never ? true : false
>;

type _PluginContextActionsMustNotExposePeerMediationRuntime = AssertTrue<
    Extract<keyof PluginContextV1['actions'], 'peerMediation'> extends never ? true : false
>;

type _PluginContextMustNotExposeCapabilitiesFacet = AssertTrue<
    Extract<keyof PluginContextV1, 'capabilities'> extends never ? true : false
>;

type _PluginContextAcpMustNotExposeProviderNamedPermissionHelpers = AssertTrue<
    Extract<keyof PluginContextV1['agentRuntime']['acp'], 'permissionHandlers'> extends never ? true : false
>;

type _PluginContextMustExposeReviewComments = AssertTrue<
    PluginContextV1['reviews'] extends Readonly<{
        comments: PluginReviewCommentsServiceV1;
    }> ? true : false
>;

type _PluginContextMustExposeAgentRuntimeFacet = AssertTrue<
    PluginContextV1['agentRuntime'] extends Readonly<{
        exec: ExecRuntimeServiceV1;
        acp: AcpAuthoringServiceV1;
        terminalHost: TerminalHostRuntimeServiceV1;
        sessionHooks: SessionHooksRuntimeServiceV1;
        transcripts: TranscriptsRuntimeServiceV1;
        agents: AgentsRuntimeServiceV1;
        accountUsage: ProviderAccountUsageRuntimeServiceV1;
    }> ? true : false
>;

type _PluginContextMustNotExposeFlatAgentAuthoringServices = AssertNever<
    Extract<
        keyof PluginContextV1,
        | 'exec'
        | 'acp'
        | 'terminalHost'
        | 'sessionHooks'
        | 'transcripts'
        | 'agents'
        | 'accountUsage'
    >
>;

type _PluginContextAgentRuntimeMustExposeTerminalHost = AssertTrue<
    PluginContextV1['agentRuntime']['terminalHost'] extends TerminalHostRuntimeServiceV1 ? true : false
>;

type _PluginContextMustExposeTranscriptFileFollow = AssertTrue<
    PluginContextV1['agentRuntime']['transcripts'] extends Readonly<{
        fileFollow: TranscriptFileFollowRuntimeServiceV1;
    }> ? true : false
>;

type _PluginContextMustNotExposeTopLevelFileFollow = AssertTrue<
    Extract<keyof PluginContextV1, 'fileFollow'> extends never ? true : false
>;

type _PluginContextMustNotExposeStableTelemetryOrArtifacts = AssertNever<
    Extract<keyof PluginContextV1, 'telemetry' | 'artifacts'>
>;

type _PluginContextExperimentalMustExposeTelemetryAndArtifacts = AssertTrue<
    PluginContextV1['experimental'] extends Readonly<{
        telemetry: Readonly<{ emit(observation: unknown): void }>;
        artifacts: Readonly<{ write(record: unknown): Promise<void> }>;
    }> ? true : false
>;

type _PluginTranscriptAppendInputMustBeTyped = AssertTrue<
    IsUnknown<Parameters<TranscriptsRuntimeServiceV1['append']>[0]> extends false ? true : false
>;
