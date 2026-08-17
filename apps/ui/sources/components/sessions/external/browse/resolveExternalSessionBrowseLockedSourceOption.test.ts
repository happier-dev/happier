import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { resolveExternalSessionBrowseLockedSource } from './resolveExternalSessionBrowseLockedSourceOption';

describe('resolveExternalSessionBrowseLockedSource', () => {
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
                        profileId: 'member-a',
                    },
                },
            },
            profile: null,
            settings: { connectedServicesProfileLabelByKey: {} },
            projection,
        })).toEqual({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'primary-pool',
        });
    });
});
