import { homedir } from 'node:os';
import { join } from 'node:path';

import {
    buildProviderSessionIdSessionMetadata,
    type ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import { resolveClaudeConfigDirOverride, resolveClaudeProjectId } from './path.js';

export type ClaudeRuntimeLocalHandoffSession = Readonly<{
    vendorResumeId?: string | null;
    spawnOptions?: Readonly<{
        resume?: string | null;
        transcriptStorage?: string | null;
        environmentVariables?: Readonly<Record<string, string | undefined>> | null;
    }> | null;
}>;

export type ClaudeRuntimeLocalHandoffMetadata = Readonly<Partial<{
    claudeSessionId: string;
    externalSessionV1: Readonly<{
        v: 1;
        agentId: 'claude';
        machineId: string;
        remoteSessionId: string;
        source: ExternalSessionsSource;
        linkedAtMs: number;
    }>;
}>>;

type MutableClaudeRuntimeLocalHandoffMetadata = Partial<{
    claudeSessionId: string;
    externalSessionV1: NonNullable<ClaudeRuntimeLocalHandoffMetadata['externalSessionV1']>;
}>;

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveClaudeConfigDir(env: NodeJS.ProcessEnv): string {
    return resolveClaudeConfigDirOverride(env) ?? join(homedir(), '.claude');
}

export function buildClaudeRuntimeLocalHandoffMetadata(params: Readonly<{
    metadata: Readonly<Record<string, unknown>>;
    session: ClaudeRuntimeLocalHandoffSession;
    vendorResumeId?: string | null;
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
}>): ClaudeRuntimeLocalHandoffMetadata {
    const runtimeLocalMetadata: MutableClaudeRuntimeLocalHandoffMetadata = {};
    const vendorResumeId =
        normalizeOptionalString(params.vendorResumeId)
        ?? normalizeOptionalString(params.session.vendorResumeId)
        ?? normalizeOptionalString(params.session.spawnOptions?.resume)
        ?? '';
    if (!vendorResumeId) {
        return runtimeLocalMetadata;
    }

    Object.assign(
        runtimeLocalMetadata,
        buildProviderSessionIdSessionMetadata({
            metadataKey: 'claudeSessionId',
            value: vendorResumeId,
        }),
    );

    if (params.session.spawnOptions?.transcriptStorage !== 'direct') {
        return runtimeLocalMetadata;
    }

    const env = {
        ...(params.env ?? process.env),
        ...(params.session.spawnOptions.environmentVariables ?? {}),
    };
    const machineId = normalizeOptionalString(params.metadata.machineId) ?? '';
    runtimeLocalMetadata.externalSessionV1 = {
        v: 1,
        agentId: 'claude',
        machineId,
        remoteSessionId: vendorResumeId,
        source: {
            kind: 'claudeConfig',
            configDir: resolveClaudeConfigDir(env),
            ...(normalizeOptionalString(params.metadata.path)
                ? { projectId: resolveClaudeProjectId(String(params.metadata.path).trim()) }
                : {}),
        },
        linkedAtMs: params.nowMs ?? Date.now(),
    };

    return runtimeLocalMetadata;
}
