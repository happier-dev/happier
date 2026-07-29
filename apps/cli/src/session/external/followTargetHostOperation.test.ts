import { describe, expect, it, vi } from 'vitest';

import type { PluginAgentContributionV2 } from '@happier-dev/protocol';

import { createExternalSessionFollowTargetHostOperation } from './followTargetHostOperation';
import type { PluginExternalSessionsProviderOps } from './pluginExternalSessionsAdapter';

const contribution = {
    id: 'codex',
    title: 'Codex',
    runtime: { kind: 'custom' },
    primary: 'sessions',
    capabilities: {
        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
    },
    surfaces: {
        externalSession: {
            sources: [{
                sourceKind: 'codexHome',
                schema: {
                    fields: [
                        { name: 'kind', kind: 'literal', value: 'codexHome' },
                        { name: 'home', kind: 'enum', values: ['user'] },
                        { name: 'homePath', kind: 'string', optional: true },
                    ],
                },
                key: {
                    segments: [
                        { kind: 'literal', value: 'codexHome' },
                        { kind: 'homeMode', field: 'home' },
                        { kind: 'field', field: 'homePath' },
                    ],
                },
                instances: [{
                    kind: 'default',
                    constants: { home: 'user' },
                }],
            }],
        },
    },
} satisfies PluginAgentContributionV2;

const agent = Object.freeze({
    id: 'codex',
    identity: Object.freeze({
        pluginId: 'happier.codex',
        localId: 'codex',
    }),
    richDefinition: Object.freeze({
        provenance: 'first_party' as const,
        definition: contribution,
    }),
});

function request(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        pluginId: 'happier.codex',
        contributionId: 'codex',
        generationId: 'generation-1',
        sessionId: 'session-1',
        machineId: 'machine-1',
        accountRevision: 'account-1',
        remoteSessionId: 'remote-1',
        isCurrent: () => true,
        ...overrides,
    };
}

describe('external-session provider-session follow target host operation', () => {
    it('resolves one exact target from the bound daemon generation without listing candidates', async () => {
        const listCandidates = vi.fn();
        const providerOps: PluginExternalSessionsProviderOps = {
            validateSource: async ({ source }) => ({ ok: true, source }),
            resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                source: {
                    ...source,
                    homePath: '/canonical/codex',
                },
                remoteSessionId,
                linkData: {},
            }),
            listCandidates,
            pageTranscript: async () => ({
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            }),
            readAfterTranscript: async () => ({
                outcome: 'already_current',
            }),
        };
        const release = vi.fn(async () => undefined);
        let accountRevision = 'account-1';
        const operation = createExternalSessionFollowTargetHostOperation({
            machineId: 'machine-1',
            dependencies: {
                acquireRuntimeContext: async () => ({
                    pluginId: 'happier.codex',
                    agentId: 'codex',
                    generationId: 'generation-1',
                    agent,
                    providerOps,
                    retirementSignal: new AbortController().signal,
                    isCurrent: () => true,
                    release,
                }),
                readAccount: async () => ({ connectedServicesV2: [] }),
                readAccountRevision: () => accountRevision,
            },
        });

        await expect(operation.execute(request())).resolves.toEqual({
            status: 'resolved',
            ref: {
                agentId: 'codex',
                sourceId: 'codexHome:user:',
                remoteSessionId: 'remote-1',
            },
            source: {
                kind: 'codexHome',
                home: 'user',
                homePath: '/canonical/codex',
            },
        });
        expect(listCandidates).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();

        accountRevision = 'account-2';
        await expect(operation.execute(request())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(listCandidates).not.toHaveBeenCalled();
    });
});
