import { describe, expect, it } from 'vitest';
import type { HostingProviderRuntimeRegistration } from '@happier-dev/plugin-sdk/scm/hosting';
import { listPublishCapableForgesV1 } from './hostRegistry';

describe('publish-capable forge catalog', () => {
    it('offers only admitted repository publishers without opening accounts or publishing repositories', () => {
        let effects = 0;
        const unexpectedEffect = async () => { effects += 1; throw new Error('Unexpected forge effect'); };
        const publisher: HostingProviderRuntimeRegistration = { id: 'publisher', adapter: { repositoryPublishing: {
            describePublishTargets: unexpectedEffect, createRepository: unexpectedEffect, getRepository: unexpectedEffect,
        } } };
        const forges = listPublishCapableForgesV1({
            contributes: { scmHostingProviders: [
                { id: 'publisher', pluginId: 'forge.publisher', provenance: 'external', source: { kind: 'path' }, definition: {
                    id: 'publisher', kind: 'github', title: 'GitHub', capabilities: [],
                } },
                { id: 'clone', pluginId: 'forge.clone', provenance: 'external', source: { kind: 'path' }, definition: {
                    id: 'clone', kind: 'gitlab', title: 'Clone only', capabilities: [],
                } },
                { id: 'inactive', pluginId: 'forge.inactive', provenance: 'external', source: { kind: 'path' }, definition: {
                    id: 'inactive', kind: 'bitbucket', title: 'Inactive', capabilities: [],
                } },
            ] },
            scmHostingProvidersById: new Map([
                ['forge.publisher/publisher', { pluginId: 'forge.publisher', occurrenceId: 'current', registration: publisher }],
                ['forge.clone/clone', { pluginId: 'forge.clone', occurrenceId: 'current', registration: { id: 'clone', adapter: {} } }],
            ]),
        });
        expect(forges).toEqual([{ providerKind: 'github', title: 'GitHub' }]);
        expect(effects).toBe(0);
    });
});
