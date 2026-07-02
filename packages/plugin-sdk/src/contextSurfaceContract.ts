import type { PluginContextV1 } from './context';
import type { PluginReviewCommentsServiceV1 } from './reviews/comments';
import type { SessionPermissionsServiceV1 } from './sessions';
import type { TerminalHostRuntimeServiceV1 } from './terminalHost';
import type { TranscriptFileFollowRuntimeServiceV1 } from './transcripts';

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _PluginContextMustNotExposeFlatPermissions = AssertTrue<
    Extract<keyof PluginContextV1, 'permissions'> extends never ? true : false
>;

type _PluginContextMustExposeCurrentSessionPermissions = AssertTrue<
    PluginContextV1['session'] extends Readonly<{
        permissions: SessionPermissionsServiceV1;
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

type _PluginContextMustExposeCapabilityInventory = AssertTrue<
    PluginContextV1['capabilities'] extends Readonly<{
        has(capability: string): boolean;
        list(): readonly string[];
    }> ? true : false
>;

type _PluginContextAcpMustNotExposeProviderNamedPermissionHelpers = AssertTrue<
    Extract<keyof PluginContextV1['acp'], 'permissionHandlers'> extends never ? true : false
>;

type _PluginContextMustExposeReviewComments = AssertTrue<
    PluginContextV1['reviews'] extends Readonly<{
        comments: PluginReviewCommentsServiceV1;
    }> ? true : false
>;

type _PluginContextMustExposeTerminalHost = AssertTrue<
    PluginContextV1['terminalHost'] extends TerminalHostRuntimeServiceV1 ? true : false
>;

type _PluginContextMustExposeTranscriptFileFollow = AssertTrue<
    PluginContextV1['transcripts'] extends Readonly<{
        fileFollow: TranscriptFileFollowRuntimeServiceV1;
    }> ? true : false
>;

type _PluginContextMustNotExposeTopLevelFileFollow = AssertTrue<
    Extract<keyof PluginContextV1, 'fileFollow'> extends never ? true : false
>;
