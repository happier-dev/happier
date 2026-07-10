import { AGENT_IDS, getAgentResumeConfig } from '@happier-dev/agents';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { splitDurableRegisteredSessionStateMetadata } from '../../pluginMetadataDurability';
import { isRecord } from './values';

const STATIC_VENDOR_SESSION_METADATA_KEYS = [
    'claudeSessionId',
    'codexSessionId',
    'geminiSessionId',
    'opencodeSessionId',
    'auggieSessionId',
    'qwenSessionId',
    'kimiSessionId',
    'kiloSessionId',
    'piSessionId',
    'copilotSessionId',
] as const;

const BASE_SESSION_STATE_METADATA_KEYS = [
    'runtimeDescriptorV1',
    'agentRuntimeDescriptorV1',
    'permissionMode',
    'permissionModeUpdatedAt',
    'modelOverrideV1',
    'modelSelectionIntentV1',
    'sessionModeOverrideV1',
    'acpSessionModeOverrideV1',
    'sessionConfigOptionOverridesV1',
    'acpConfigOptionOverridesV1',
    'summary',
    'readStateV1',
    'externalSessionAttentionV1',
] as const;

function getSessionStateMetadataKeys(): ReadonlySet<string> {
    const manifestVendorKeys: readonly string[] = Array.isArray(AGENT_IDS)
        ? AGENT_IDS.flatMap((agentId) => {
            const field = getAgentResumeConfig(agentId).vendorResumeIdField;
            return typeof field === 'string' && field.length > 0 ? [field] : [];
        })
        : STATIC_VENDOR_SESSION_METADATA_KEYS;
    return new Set<string>([
        ...BASE_SESSION_STATE_METADATA_KEYS,
        ...manifestVendorKeys,
    ]);
}

export function isMetadataRecord(value: unknown): value is Record<string, unknown> {
    return isRecord(value);
}

export function preserveSessionStateMetadataKeys(
    current: unknown,
    candidate: unknown,
): Record<string, unknown> {
    const currentRecord = isMetadataRecord(current) ? current : {};
    const candidateRecord = isMetadataRecord(candidate) ? candidate : {};
    const next: Record<string, unknown> = { ...candidateRecord };

    for (const key of getSessionStateMetadataKeys()) {
        if (Object.prototype.hasOwnProperty.call(currentRecord, key)) {
            next[key] = currentRecord[key];
        } else {
            delete next[key];
        }
    }

    return next;
}

type PluginMetadataDurableSession = Pick<
    ApiSessionClient,
    'sessionId' | 'enqueueRegisteredSessionStateFieldMutation'
>;

export type RegisteredSessionStateFieldMutationForPluginWrite = Parameters<
    PluginMetadataDurableSession['enqueueRegisteredSessionStateFieldMutation']
>[0];

export function splitPluginMetadataDurableRegisteredFields(params: Readonly<{
    session: Partial<PluginMetadataDurableSession> & Pick<ApiSessionClient, 'sessionId'>;
    current: unknown;
    candidate: unknown;
    source: RegisteredSessionStateFieldMutationForPluginWrite['source'];
}>): Readonly<{
    metadata: Record<string, unknown>;
    mutations: readonly RegisteredSessionStateFieldMutationForPluginWrite[];
}> {
    if (typeof params.session.enqueueRegisteredSessionStateFieldMutation !== 'function') {
        return {
            metadata: isMetadataRecord(params.candidate) ? params.candidate : {},
            mutations: [],
        };
    }
    return splitDurableRegisteredSessionStateMetadata({
        sessionId: params.session.sessionId,
        current: params.current,
        candidate: params.candidate,
        source: params.source,
    });
}

export async function publishPluginMetadataDurableRegisteredFieldMutations(
    session: Partial<PluginMetadataDurableSession>,
    mutations: readonly RegisteredSessionStateFieldMutationForPluginWrite[],
): Promise<void> {
    if (typeof session.enqueueRegisteredSessionStateFieldMutation !== 'function') return;
    for (const mutation of mutations) {
        await session.enqueueRegisteredSessionStateFieldMutation(mutation);
    }
}
