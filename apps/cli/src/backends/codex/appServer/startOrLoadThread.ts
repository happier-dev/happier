import type { CodexAppServerPolicy } from '../utils/permissionModePolicy';

import type { DisposableCodexAppServerClient } from './client/createCodexAppServerClient';
import {
    buildThreadServiceTierParams,
    readModelId,
    readServiceTier,
    readThreadId,
    trimSessionId,
} from './readCodexAppServerRpcFields';

export type CodexAppServerStartOrLoadOptions = Readonly<{
    resumeId?: string | null;
    existingSessionId?: string | null;
    importHistory?: boolean;
    preserveRequestedThreadId?: boolean;
}>;

export async function startOrLoadCodexAppServerThread(params: Readonly<{
    client: DisposableCodexAppServerClient;
    directory: string;
    options?: CodexAppServerStartOrLoadOptions;
    currentModelId: string | null;
    currentServiceTier: string | null;
    hasServiceTierOverride: boolean;
    resolveCurrentPolicy: () => CodexAppServerPolicy | null;
}>): Promise<Readonly<{
    threadId: string;
    modelId: string | null;
    serviceTier: string | null;
}>> {
    const options = params.options ?? {};
    const resumeId = trimSessionId(options.resumeId);
    const existingSessionId = trimSessionId(options.existingSessionId);
    // null policy (Happier 'default') → omit approvalPolicy/sandbox so Codex uses ~/.codex/config.toml.
    const policy = params.resolveCurrentPolicy();
    const policyFields = policy ? { approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox } : {};

    let response: unknown;
    let nextThreadId: string | null = null;

    if (resumeId) {
        response = await params.client.request('thread/resume', {
            threadId: resumeId,
            ...(params.currentModelId ? { model: params.currentModelId } : {}),
            ...buildThreadServiceTierParams(params.currentServiceTier, params.hasServiceTierOverride),
            ...policyFields,
            persistExtendedHistory: true,
        });
        nextThreadId = options.preserveRequestedThreadId === true ? resumeId : readThreadId(response) ?? resumeId;
    } else if (existingSessionId) {
        response = await params.client.request('thread/resume', {
            threadId: existingSessionId,
            ...(params.currentModelId ? { model: params.currentModelId } : {}),
            ...buildThreadServiceTierParams(params.currentServiceTier, params.hasServiceTierOverride),
            ...policyFields,
            persistExtendedHistory: true,
        });
        nextThreadId = options.preserveRequestedThreadId === true ? existingSessionId : readThreadId(response) ?? existingSessionId;
    } else {
        response = await params.client.request('thread/start', {
            cwd: params.directory,
            ...(params.currentModelId ? { model: params.currentModelId } : {}),
            ...buildThreadServiceTierParams(params.currentServiceTier, params.hasServiceTierOverride),
            ...policyFields,
            experimentalRawEvents: true,
            persistExtendedHistory: true,
        });
        nextThreadId = readThreadId(response);
        if (!nextThreadId) {
            throw new Error('Codex app-server thread/start returned no thread id');
        }
    }

    const serviceTierFromResponse = readServiceTier(response);
    const nextServiceTier = serviceTierFromResponse !== null
        ? serviceTierFromResponse
        : params.hasServiceTierOverride
            ? params.currentServiceTier
            : null;

    return {
        threadId: nextThreadId,
        modelId: readModelId(response) ?? params.currentModelId,
        serviceTier: nextServiceTier,
    };
}
