import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import {
    deriveExternalSessionActivity,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsResolvedIdentity,
    AgentExternalSessionObservationLinkEvidenceBatchV1,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    isSafeClaudeJsonlPathSegment,
    resolveClaudeJsonlSessionFile,
} from './files.js';
import {
    validateClaudeExternalSessionSource,
    type ClaudeExternalSessionSource,
} from './source.js';

const RESOURCE_KEY_PREFIX = 'claude-jsonl-resource-v1:';
const LINK_KEY_PREFIX = 'claude-jsonl-link-v1:';
const RECONCILIATION_FACT_TTL_MS = 15_000;

type ClaudeObservationIdentity = Readonly<{
    source: ClaudeExternalSessionSource;
    configDir: string;
    projectId: string;
    remoteSessionId: string;
}>;
type AuthorizedClaudeObservationIdentity = ClaudeObservationIdentity & Readonly<{
    filePath: string;
}>;
type ExternalAgentObservationLeafFact =
    AgentExternalSessionObservationLinkEvidenceBatchV1['items'][number]['facts'][number];

function hashOpaqueIdentity(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(value), 'utf8')
        .digest('base64url');
}

function readRequiredPathSegment(value: unknown, label: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!isSafeClaudeJsonlPathSegment(normalized)) {
        throw new Error(`Claude observation requires a valid ${label}`);
    }
    return normalized;
}

function resolveIdentity(
    identity: AgentExternalSessionsResolvedIdentity,
    env: NodeJS.ProcessEnv,
): ClaudeObservationIdentity {
    if (identity.source.kind !== 'claudeConfig') {
        throw new Error('provider/source mismatch');
    }
    const sourceProjectId = identity.source.projectId;
    const linkProjectId = identity.linkData.projectId;
    const projectId = readRequiredPathSegment(
        linkProjectId ?? sourceProjectId,
        'project id',
    );
    if (
        typeof sourceProjectId === 'string'
        && sourceProjectId.trim().length > 0
        && sourceProjectId.trim() !== projectId
    ) {
        throw new Error('Claude observation source and link project ids disagree');
    }
    const remoteSessionId = readRequiredPathSegment(
        identity.remoteSessionId,
        'native session id',
    );
    const source: ClaudeExternalSessionSource = {
        kind: 'claudeConfig',
        ...(typeof identity.source.configDir === 'string'
            ? { configDir: identity.source.configDir }
            : {}),
        projectId,
    };
    const validation = validateClaudeExternalSessionSource({ source, env });
    if (!validation.ok || validation.source.kind !== 'claudeConfig') {
        throw new Error(validation.ok ? 'provider/source mismatch' : validation.error);
    }
    const configDir = typeof validation.source.configDir === 'string'
        ? validation.source.configDir
        : '';
    if (!configDir) {
        throw new Error('Claude observation requires a canonical config directory');
    }
    return {
        source: validation.source,
        configDir,
        projectId,
        remoteSessionId,
    };
}

async function resolveAuthorizedIdentity(params: Readonly<{
    identity: ClaudeObservationIdentity;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
}>): Promise<AuthorizedClaudeObservationIdentity | null> {
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.identity.source,
        env: params.env,
        remoteSessionId: params.identity.remoteSessionId,
        signal: params.signal,
    });
    if (!resolved || resolved.projectId !== params.identity.projectId) return null;
    return {
        ...params.identity,
        filePath: resolved.filePath,
    };
}

function describeIdentity(
    identity: ClaudeObservationIdentity,
): Readonly<{
    resourceKey: string;
    linkKey: string;
}> {
    return {
        resourceKey: `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity([
            identity.configDir,
            identity.projectId,
            identity.remoteSessionId,
        ])}`,
        linkKey: `${LINK_KEY_PREFIX}${hashOpaqueIdentity([
            identity.configDir,
            identity.projectId,
            identity.remoteSessionId,
        ])}`,
    };
}

function describeResolvedIdentity(
    resolved: AuthorizedClaudeObservationIdentity,
): Readonly<{
    resourceKey: string;
    linkKey: string;
    changeObservation: 'watch_file_changes';
    watchFileChanges: Readonly<{ files: string[] }>;
}> {
    return {
        ...describeIdentity(resolved),
        changeObservation: 'watch_file_changes',
        watchFileChanges: {
            files: [resolved.filePath],
        },
    };
}

function retrievalFailedFact(observedAtMs: number): ExternalAgentObservationLeafFact {
    return {
        kind: 'retrieval_failed',
        evidenceClass: 'reconciliation',
        observedAtMs,
        axis: 'turn_phase',
    };
}

export function createClaudeExternalSessionObservationContribution(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    now?: () => number;
}> = {}): AgentExternalSessionObservationContribution {
    const readEnv = () => params.env ?? process.env;
    const now = params.now ?? Date.now;

    return Object.freeze({
        describeResource(request) {
            return describeIdentity(resolveIdentity(request, readEnv()));
        },

        observeResource(request) {
            request.signal.throwIfAborted();
            if (!request.resourceKey.startsWith(RESOURCE_KEY_PREFIX)) {
                throw new Error('Claude observation resource key is invalid');
            }
            // The public activation facet has no runtime service context. File
            // observation therefore remains with the host's canonical fileFollow
            // owner; this leaf does not create a competing fs watcher or timer.
            return Object.freeze({
                dispose() {},
            });
        },

        async reconcileResource(request) {
            request.signal.throwIfAborted();
            if (request.links.length === 0) {
                throw new Error('Claude observation reconciliation requires a current link');
            }
            if (request.purpose === 'resource_descriptors') {
                const outcomes = await Promise.all(request.links.map(async (link) => {
                    try {
                        const resolved = await resolveAuthorizedIdentity({
                            identity: resolveIdentity(link.linkedSource, readEnv()),
                            env: readEnv(),
                            signal: request.signal,
                        });
                        request.signal.throwIfAborted();
                        if (!resolved) {
                            return { kind: 'unavailable' as const, linkKey: link.linkKey };
                        }
                        const descriptor = describeResolvedIdentity(resolved);
                        if (
                            descriptor.resourceKey !== request.resourceKey
                            || descriptor.linkKey !== link.linkKey
                        ) {
                            return { kind: 'unavailable' as const, linkKey: link.linkKey };
                        }
                        return { kind: 'described' as const, descriptor };
                    } catch (error) {
                        if (request.signal.aborted) throw error;
                        return { kind: 'unavailable' as const, linkKey: link.linkKey };
                    }
                }));
                request.signal.throwIfAborted();
                return {
                    purpose: 'resource_descriptors',
                    outcomes,
                };
            }
            const observedAtMs = now();
            const outcomes = [];
            for (const link of request.links) {
                request.signal.throwIfAborted();
                try {
                    const resolved = await resolveAuthorizedIdentity({
                        identity: resolveIdentity(link.linkedSource, readEnv()),
                        env: readEnv(),
                        signal: request.signal,
                    });
                    if (!resolved) {
                        outcomes.push({
                            linkKey: link.linkKey,
                            facts: [retrievalFailedFact(observedAtMs)],
                        });
                        continue;
                    }
                    const descriptor = describeResolvedIdentity(resolved);
                    if (
                        descriptor.resourceKey !== request.resourceKey
                        || descriptor.linkKey !== link.linkKey
                    ) {
                        outcomes.push({
                            linkKey: link.linkKey,
                            facts: [retrievalFailedFact(observedAtMs)],
                        });
                        continue;
                    }
                    const file = await stat(resolved.filePath);
                    request.signal.throwIfAborted();
                    if (!file.isFile()) {
                        outcomes.push({
                            linkKey: link.linkKey,
                            facts: [retrievalFailedFact(observedAtMs)],
                        });
                        continue;
                    }
                    const activity = deriveExternalSessionActivity({
                        updatedAtMs: file.mtimeMs,
                        nowMs: observedAtMs,
                        env: readEnv(),
                    });
                    outcomes.push({
                        linkKey: link.linkKey,
                        facts: activity === 'active_recently'
                            ? [{
                                kind: 'recent_activity' as const,
                                evidenceClass: 'reconciliation' as const,
                                observedAtMs,
                                expiresAtMs: observedAtMs + RECONCILIATION_FACT_TTL_MS,
                            }]
                            : activity === 'idle'
                                ? [{
                                    kind: 'successful_empty' as const,
                                    evidenceClass: 'reconciliation' as const,
                                    observedAtMs,
                                    expiresAtMs: observedAtMs + RECONCILIATION_FACT_TTL_MS,
                                    emptyTurnPhase: 'unsupported' as const,
                                }]
                                : [retrievalFailedFact(observedAtMs)],
                    });
                } catch (error) {
                    if (request.signal.aborted) throw error;
                    outcomes.push({
                        linkKey: link.linkKey,
                        facts: [retrievalFailedFact(observedAtMs)],
                    });
                }
            }
            return {
                purpose: 'observation_evidence',
                outcomes,
            };
        },
    });
}

export const claudeExternalSessionObservationContribution =
    createClaudeExternalSessionObservationContribution();
