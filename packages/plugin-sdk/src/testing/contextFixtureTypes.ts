import type {
    PluginContextV1,
    PluginEventEmitInputV1,
} from '../context.js';
import type { FetchRuntimeRequestV1, FetchRuntimeServiceV1 } from '../fetch.js';
import type {
    SessionAgentStateWriteRequestV1,
    SessionMetadataWriteRequestV1,
    SessionPermissionDecisionRequestV1,
    SessionPermissionDecisionResultV1,
    SessionProviderAcceptedUserMessageDeliveryQueryV1,
    SessionStateFieldWriteRequestV1,
} from '../sessions/scoped.js';

export type PluginContextFixtureLogV1 = Readonly<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    fields?: Readonly<Record<string, unknown>>;
}>;

export type PluginContextFixtureRecordsV1 = Readonly<{
    logs: PluginContextFixtureLogV1[];
    fetchRequests: FetchRuntimeRequestV1[];
    eventEmits: PluginEventEmitInputV1[];
    telemetry: unknown[];
    artifactWrites: unknown[];
    transcriptAppends: unknown[];
    transcriptSourceDefinitions: unknown[];
    sessionSends: unknown[];
    sessionMetadataWrites: unknown[];
    sessionAgentStateWrites: unknown[];
    sessionStateFieldWrites: unknown[];
}>;

export type PluginContextFixtureOptionsV1 = Readonly<{
    fetch?: FetchRuntimeServiceV1;
    sessionId?: string;
    config?: Readonly<Record<string, unknown>>;
    enabledCapabilities?: readonly string[];
    enabledFeatures?: readonly string[];
    onSessionMetadataWrite?: (request: SessionMetadataWriteRequestV1) => Promise<void> | void;
    onSessionAgentStateWrite?: (request: SessionAgentStateWriteRequestV1) => Promise<void> | void;
    onSessionStateFieldWrite?: (request: SessionStateFieldWriteRequestV1) => Promise<void> | void;
    hasProviderAcceptedUserMessageDelivery?: (
        query: SessionProviderAcceptedUserMessageDeliveryQueryV1,
    ) => boolean;
    onPermissionDecision?: (
        request: SessionPermissionDecisionRequestV1,
    ) => Promise<SessionPermissionDecisionResultV1> | SessionPermissionDecisionResultV1;
}>;

export type PluginContextFixtureServicesV1 = Readonly<{
    writeMetadata: PluginContextV1['sessions']['current']['writeMetadata'];
    writeAgentState: PluginContextV1['sessions']['current']['writeAgentState'];
    writeStateField: PluginContextV1['sessions']['current']['writeStateField'];
    requestPermissionDecision: PluginContextV1['sessions']['current']['permissions']['requestDecision'];
}>;

export type PluginContextFixtureV1 = Readonly<{
    ctx: PluginContextV1;
    records: PluginContextFixtureRecordsV1;
    services: PluginContextFixtureServicesV1;
}>;
