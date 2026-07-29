import type {
    ExternalSessionsSource,
} from '@happier-dev/protocol';
import { ExternalSessionsAgentIdSchema } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { HostExternalSessionRef } from './privateContract';

export type ExternalSessionTakeoverHostOperationRequest = Readonly<{
    pluginId: string;
    contributionId: string;
    generationId: string;
    accountRevision: string;
    sessionId: string;
    machineId: string;
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>;

export type ExternalSessionTakeoverHostOperation = Readonly<{
    execute(request: ExternalSessionTakeoverHostOperationRequest): Promise<{
        sessionId: string;
        status: 'attached' | 'takenOver';
    }>;
}>;

type HostTakeoverResult =
    | Readonly<{
        ok: true;
        sessionId: string;
        takeoverStatus?: 'attached' | 'takenOver';
    }>
    | Readonly<{
        ok: false;
        errorCode: string;
        error: string;
    }>;

function fail(code: string): never {
    throw new PluginError({ code, message: code });
}

function readRequiredIdentity(value: string, code: string): string {
    const normalized = value.trim();
    return normalized || fail(code);
}

function assertRequestCurrent(request: ExternalSessionTakeoverHostOperationRequest): void {
    if (request.signal?.aborted) fail('plugin_operation_aborted');
    let current = false;
    try {
        current = request.isCurrent() === true;
    } catch {
        current = false;
    }
    if (!current) fail('plugin_generation_retired');
}

export function createExternalSessionTakeoverHostOperation(params: Readonly<{
    ensureLink(input: Readonly<{
        machineId: string;
        agentId: string;
        remoteSessionId: string;
        source: ExternalSessionsSource;
    }>): Promise<Readonly<{ ok: boolean; sessionId?: string; error?: string; errorCode?: string }>>;
    takeover(input: Readonly<{
        linkedSessionId: string;
        targetRuntimeMode: 'terminal';
        storageMode: 'external-linked';
        machineId: string;
    }>): Promise<HostTakeoverResult>;
}>): ExternalSessionTakeoverHostOperation {
    return Object.freeze({
        async execute(request) {
            const pluginId = readRequiredIdentity(request.pluginId, 'plugin_external_takeover_identity_invalid');
            const contributionId = readRequiredIdentity(request.contributionId, 'plugin_external_takeover_identity_invalid');
            readRequiredIdentity(request.generationId, 'plugin_external_takeover_identity_invalid');
            readRequiredIdentity(request.accountRevision, 'plugin_external_takeover_identity_invalid');
            readRequiredIdentity(request.sessionId, 'plugin_external_takeover_identity_invalid');
            const machineId = readRequiredIdentity(request.machineId, 'plugin_external_takeover_identity_invalid');
            const agentId = ExternalSessionsAgentIdSchema.parse(request.ref.agentId);
            if (contributionId !== agentId || pluginId.length === 0) {
                fail('plugin_external_takeover_identity_mismatch');
            }
            readRequiredIdentity(request.ref.sourceId, 'plugin_external_takeover_identity_invalid');
            readRequiredIdentity(request.ref.remoteSessionId, 'plugin_external_takeover_identity_invalid');
            assertRequestCurrent(request);

            const linked = await params.ensureLink({
                machineId,
                agentId,
                remoteSessionId: request.ref.remoteSessionId,
                source: request.source,
            });
            if (!linked.ok || typeof linked.sessionId !== 'string' || linked.sessionId.trim().length === 0) {
                fail(linked.errorCode ?? linked.error ?? 'plugin_external_attach_unavailable');
            }
            assertRequestCurrent(request);

            // Calling takeover is the commit boundary. Once the canonical action returns success,
            // later cancellation or retirement must not relabel that committed host effect.
            const result = await params.takeover({
                linkedSessionId: linked.sessionId,
                targetRuntimeMode: 'terminal',
                storageMode: 'external-linked',
                machineId,
            });
            if (!result.ok) fail(result.errorCode || result.error);
            return Object.freeze({
                sessionId: result.sessionId,
                status: result.takeoverStatus ?? 'takenOver',
            });
        },
    });
}
