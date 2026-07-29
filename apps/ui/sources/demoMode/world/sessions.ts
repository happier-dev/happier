import {
    buildLinkedExternalSessionMetadataV1,
    buildLinkedExternalSessionQualifiedIdentityV1,
} from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';

import {
    DEMO_ATTENTION_SESSION_ID,
    DEMO_HOME_DIR,
    DEMO_MACHINE_ID,
    DEMO_NOW_MS,
    DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
    DEMO_PROJECT_PATH,
    DEMO_REVIEW_SESSION_ID,
    DEMO_RICH_SESSION_ID,
    DEMO_SECONDARY_MACHINE_ID,
    DEMO_SERVER_BASE_URL,
} from './constants';

export type CreateDemoOpenCodeSessionFixtureOptions = Partial<Session> & Readonly<{
    machineId?: string | null;
    path?: string;
    title?: string;
    providerSessionId?: string;
    serverBaseUrl?: string;
    nowMs?: number;
}>;

function buildRuntimeDescriptor(params: Readonly<{
    providerSessionId: string;
    serverBaseUrl: string;
}>) {
    return {
        v: 1,
        agentId: 'opencode',
        agent: {
            backendMode: 'server',
            providerSessionId: params.providerSessionId,
            serverBaseUrl: params.serverBaseUrl,
            serverBaseUrlExplicit: true,
            agentExtra: {
                owner: 'opencode',
                schemaId: 'opencode.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: {
                    backendMode: 'server',
                    providerSessionId: params.providerSessionId,
                    serverBaseUrl: params.serverBaseUrl,
                    serverBaseUrlExplicit: true,
                },
            },
        },
    } as const;
}

function buildModelMetadata(nowMs: number) {
    return {
        sessionModelsV1: {
            v: 1,
            agentId: 'opencode',
            updatedAt: nowMs,
            currentModelId: 'claude-sonnet-4.5',
            availableModels: [
                {
                    id: 'claude-sonnet-4.5',
                    name: 'Claude Sonnet 4.5',
                    description: 'Balanced review and implementation work',
                    contextWindowTokens: 200_000,
                },
                {
                    id: 'gpt-5-codex',
                    name: 'GPT-5 Codex',
                    description: 'Focused code implementation',
                    contextWindowTokens: 400_000,
                },
            ],
        },
        sessionConfigOptionsV1: {
            v: 1,
            agentId: 'opencode',
            updatedAt: nowMs,
            configOptions: [
                {
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'enum',
                    currentValue: 'high',
                    options: [
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                },
            ],
        },
    } satisfies Pick<NonNullable<Session['metadata']>, 'sessionModelsV1' | 'sessionConfigOptionsV1'>;
}

export function createDemoOpenCodeSessionFixture(options: CreateDemoOpenCodeSessionFixtureOptions = {}): Session {
    const {
        machineId = null,
        path = DEMO_PROJECT_PATH,
        title = 'Dashboard auth skeleton',
        providerSessionId = DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
        serverBaseUrl = DEMO_SERVER_BASE_URL,
        nowMs = DEMO_NOW_MS,
        metadata: metadataOverrides,
        ...sessionOverrides
    } = options;
    const runtimeDescriptorV1 = buildRuntimeDescriptor({ providerSessionId, serverBaseUrl });
    const source = {
        kind: 'opencodeServer',
        baseUrl: serverBaseUrl,
        directory: path,
    } as const;
    const linkedMetadata = buildLinkedExternalSessionMetadataV1(
        {
            path,
            host: 'macbook-pro.local',
            homeDir: DEMO_HOME_DIR,
            name: title,
            ...(machineId ? { machineId } : {}),
            summary: { text: title, updatedAt: nowMs },
            opencodeSessionId: providerSessionId,
            opencodeBackendMode: 'server',
            opencodeServerBaseUrl: serverBaseUrl,
            opencodeServerBaseUrlExplicit: true,
            runtimeDescriptorV1,
            readStateV1: { v: 1, sessionSeq: 10, pendingActivityAt: nowMs - 20_000, updatedAt: nowMs },
            externalSessionAttentionV1: {
                v: 1,
                observedProgressToken: '3:demo-msg-agent-2',
                viewedProgressToken: '3:demo-msg-agent-2',
                observedAtMs: nowMs - 90_000,
                viewedAtMs: nowMs - 90_000,
            },
            ...buildModelMetadata(nowMs),
        },
        {
            v: 1,
            agentId: 'opencode',
            machineId: machineId ?? DEMO_MACHINE_ID,
            remoteSessionId: providerSessionId,
            source,
            qualifiedIdentity: buildLinkedExternalSessionQualifiedIdentityV1({
                agent: {
                    pluginId: 'happier.agent.opencode',
                    localId: 'opencode',
                },
                sourceKind: source.kind,
            }),
            linkData: { runtimeDescriptorV1 },
            linkedAtMs: nowMs - 240_000,
            lastKnownActivityAtMs: nowMs,
            runtimeDescriptorV1,
        },
    );

    return {
        id: DEMO_RICH_SESSION_ID,
        seq: 10,
        lastViewedSessionSeq: 10,
        encryptionMode: 'plain',
        createdAt: nowMs - 240_000,
        updatedAt: nowMs,
        meaningfulActivityAt: nowMs,
        active: true,
        activeAt: nowMs,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
        metadata: {
            ...linkedMetadata,
            ...(metadataOverrides ?? {}),
            path: typeof metadataOverrides?.path === 'string' ? metadataOverrides.path : path,
            host: typeof metadataOverrides?.host === 'string' ? metadataOverrides.host : 'macbook-pro.local',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: true,
        thinkingAt: nowMs - 3_000,
        presence: 'online',
        permissionMode: 'default',
        modelMode: 'default',
        ...sessionOverrides,
    };
}

function createDemoListSession(params: Readonly<{
    id: string;
    machineId: string;
    title: string;
    path?: string;
    active: boolean;
    activeAt: number;
    seq: number;
    pendingBlockedCount?: number;
    pendingCount?: number;
    pendingUserActionRequestCount?: number;
    thinking?: boolean;
}>): Session {
    const thinking = params.thinking ?? params.active;
    return {
        id: params.id,
        seq: params.seq,
        lastViewedSessionSeq: params.pendingCount ? Math.max(0, params.seq - params.pendingCount) : params.seq,
        encryptionMode: 'plain',
        createdAt: params.activeAt - 120_000,
        updatedAt: params.activeAt,
        meaningfulActivityAt: params.activeAt,
        active: params.active,
        activeAt: params.activeAt,
        pendingCount: params.pendingCount ?? 0,
        pendingBlockedCount: params.pendingBlockedCount ?? 0,
        pendingUserActionRequestCount: params.pendingUserActionRequestCount ?? 0,
        pendingVersion: params.pendingCount ? 1 : 0,
        metadata: {
            path: params.path ?? '',
            host: params.machineId === DEMO_MACHINE_ID ? 'macbook-pro.local' : 'studio.local',
            homeDir: DEMO_HOME_DIR,
            name: params.title,
            machineId: params.machineId,
            summary: { text: params.title, updatedAt: params.activeAt },
            readStateV1: {
                v: 1,
                sessionSeq: params.seq,
                pendingActivityAt: params.pendingCount ? params.activeAt - 20_000 : 0,
                updatedAt: params.activeAt,
            },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking,
        thinkingAt: thinking ? params.activeAt - 1_000 : 0,
        presence: params.active || thinking ? 'online' : params.activeAt,
        permissionMode: 'default',
        modelMode: 'default',
    };
}

export function buildDemoSessions(): Session[] {
    return [
        createDemoOpenCodeSessionFixture(),
        createDemoListSession({
            id: DEMO_REVIEW_SESSION_ID,
            machineId: DEMO_SECONDARY_MACHINE_ID,
            title: 'Review mobile PR from the train',
            active: false,
            activeAt: DEMO_NOW_MS - 900_000,
            seq: 11,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingUserActionRequestCount: 1,
        }),
        createDemoListSession({
            id: DEMO_ATTENTION_SESSION_ID,
            machineId: DEMO_MACHINE_ID,
            title: 'Production incident follow-up',
            active: false,
            activeAt: DEMO_NOW_MS - 1_800_000,
            seq: 12,
            pendingBlockedCount: 1,
        }),
        createDemoListSession({
            id: 'demo-session-api-contract',
            machineId: DEMO_MACHINE_ID,
            title: 'API contract migration',
            active: true,
            activeAt: DEMO_NOW_MS - 70_000,
            seq: 13,
            thinking: true,
        }),
        createDemoListSession({
            id: 'demo-session-ios-smoke',
            machineId: DEMO_SECONDARY_MACHINE_ID,
            title: 'iOS smoke retry',
            active: true,
            activeAt: DEMO_NOW_MS - 3_000_000,
            seq: 14,
            thinking: true,
        }),
        createDemoListSession({
            id: 'demo-session-docs-refresh',
            machineId: DEMO_MACHINE_ID,
            title: 'Docs screenshot refresh',
            active: false,
            activeAt: DEMO_NOW_MS - 5_400_000,
            seq: 15,
        }),
        createDemoListSession({
            id: 'demo-session-terminal-latency',
            machineId: DEMO_SECONDARY_MACHINE_ID,
            title: 'Terminal latency pass',
            active: false,
            activeAt: DEMO_NOW_MS - 7_200_000,
            seq: 16,
        }),
        createDemoListSession({
            id: 'demo-session-release-notes',
            machineId: DEMO_MACHINE_ID,
            title: 'Release notes draft',
            active: false,
            activeAt: DEMO_NOW_MS - 10_800_000,
            seq: 17,
        }),
        createDemoListSession({
            id: 'demo-session-refactor-plan',
            machineId: DEMO_SECONDARY_MACHINE_ID,
            title: 'Provider registry refactor plan',
            active: false,
            activeAt: DEMO_NOW_MS - 21_600_000,
            seq: 18,
        }),
    ];
}
