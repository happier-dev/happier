import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import {
    canBrowseExternalSessions,
    resolveExternalSessionBrowseLockedSource,
} from './resolveExternalSessionBrowseLockedSourceOption';

/**
 * An ACP `session/list`-backed source: it can enumerate candidates to resume in
 * Happier, but it declares neither link identity nor any takeover/follow
 * guarantee, so it is offerable only to the remote-session-id picker.
 */
function createResumeOnlyListingProjection() {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 4,
        installedPackagesById: {
            'happier.agent.fx': {
                id: 'happier.agent.fx',
                displayName: 'FX',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.fx' },
            },
        },
        agentsById: {
            fx: {
                id: 'fx',
                title: 'FX',
                externalSessions: {
                    agent: { pluginId: 'happier.agent.fx', localId: 'fx' },
                    generation: 4,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: false,
                        pageTranscript: false,
                        readAfterTranscript: false,
                    },
                    sources: [{
                        sourceKind: 'fxAcpSessionList',
                        resumeOnly: true,
                        schema: {
                            fields: [{ name: 'kind', kind: 'literal', value: 'fxAcpSessionList' }],
                        },
                        key: { segments: [{ kind: 'literal', value: 'fxAcpSessionList' }] },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        },
    });
}

describe('resolveExternalSessionBrowseLockedSource', () => {
    it('reaches a resume-only listing source only for the remote-session-id picker', () => {
        const projection = createResumeOnlyListingProjection();
        const lockParams = {
            providerId: 'fx',
            agentOptionState: null,
            profile: null,
            labelsByKey: {},
            projection,
        } as const;

        // Ordinary External Sessions browsing (open/link a session) must never
        // see a listing-only source.
        expect(canBrowseExternalSessions({ agentId: 'fx', projection })).toBe(false);
        expect(resolveExternalSessionBrowseLockedSource(lockParams)).toBeNull();

        // The resume-id picker is the one interaction the declaration admits.
        expect(canBrowseExternalSessions({
            agentId: 'fx',
            projection,
            interaction: 'pickRemoteSessionId',
        })).toBe(true);
        expect(resolveExternalSessionBrowseLockedSource({
            ...lockParams,
            interaction: 'pickRemoteSessionId',
        })).toEqual({ kind: 'fxAcpSessionList' });
    });

    it('resolves a Codex connected-service group through the plugin-owned browse behavior', () => {
        const projection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 1,
            installedPackagesById: {
                'happier.agent.codex': {
                    id: 'happier.agent.codex',
                    displayName: 'Codex',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.agent.codex' },
                },
            },
            agentsById: {
                codex: {
                    id: 'codex',
                    externalSessions: {
                        agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                        generation: 1,
                        operations: {
                            listCandidates: true,
                            resolveLinkIdentity: true,
                            pageTranscript: true,
                            readAfterTranscript: true,
                        },
                        sources: [{
                            sourceKind: 'codexHome',
                            schema: {
                                fields: [
                                    { name: 'kind', kind: 'literal', value: 'codexHome' },
                                    { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
                                    { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
                                    { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
                                    { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
                                ],
                                refinements: [
                                    { kind: 'requiresWhenEquals', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
                                    { kind: 'forbidsWhenEquals', fields: ['connectedServiceId', 'connectedServiceProfileId', 'connectedServiceGroupId'], when: { field: 'home', equals: 'user' } },
                                ],
                            },
                            key: {
                                segments: [
                                    { kind: 'literal', value: 'codexHome' },
                                    { kind: 'homeMode', field: 'home' },
                                    { kind: 'conditionalField', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
                                    { kind: 'connectedServiceScope', groupField: 'connectedServiceGroupId', profileField: 'connectedServiceProfileId', when: { field: 'home', equals: 'connectedService' } },
                                ],
                            },
                            instances: [{ kind: 'default', constants: { home: 'user' } }],
                        }],
                    },
                },
            },
        });
        expect(resolveExternalSessionBrowseLockedSource({
            providerId: 'codex',
            agentOptionState: {
                connectedServicesBindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'primary-pool',
                    },
                },
            },
            profile: null,
            labelsByKey: {},
            projection,
        })).toEqual({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'primary-pool',
        });
    });
});
