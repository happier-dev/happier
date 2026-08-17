import { describe, expect, it } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol';

import { validatePluginEventAutomationSetupResult } from './pluginEventAutomationSetupResult';

const eligibleEvent = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
    event: {
        id: 'acme.github/events/repository',
        identity: { pluginId: 'acme.github', localId: 'events/repository' },
        immutableGenerationId: 'github-generation-a',
        title: 'Repository updates',
        description: null,
        payloadSchema: {
            type: 'object',
            properties: { eventId: { type: 'string' } },
            required: ['eventId'],
            additionalProperties: false,
        },
        automation: {
            v: 1,
            eligible: true,
            source: {
                sourceContractVersion: 3,
                supportedObservationTransports: ['checkpointedPull'],
                sourceConfigSchema: {
                    type: 'object',
                    properties: { repositoryId: { type: 'string', minLength: 1 } },
                    required: ['repositoryId'],
                    additionalProperties: false,
                },
                setupActionRef: {
                    pluginId: 'acme.github',
                    localId: 'setup/repository-source',
                },
            },
        },
    },
    setupAction: {
        id: 'acme.github/actions/setup/repository-source',
        identity: { pluginId: 'acme.github', localId: 'setup/repository-source' },
        immutableGenerationId: 'github-generation-a',
        title: 'Configure repository source',
        description: null,
        inputSchema: {
            type: 'object',
            properties: { repository: { type: 'string', minLength: 1 } },
            required: ['repository'],
            additionalProperties: false,
        },
        inputHints: null,
    },
});

describe('Plugin Event Automation setup-result validation', () => {
    it('accepts only the selected Event declaration contract before the Automation writer', () => {
        expect(validatePluginEventAutomationSetupResult({
            eligibleEvent,
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
        })).toEqual({
            kind: 'available',
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
        });
    });

    it('rejects a syntactically valid setup result from a different source contract or config shape', () => {
        expect(validatePluginEventAutomationSetupResult({
            eligibleEvent,
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 2,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
        })).toEqual({ kind: 'invalid' });

        expect(validatePluginEventAutomationSetupResult({
            eligibleEvent,
            result: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: 42 },
                displayLabel: 'acme/widgets',
            },
        })).toEqual({ kind: 'invalid' });
    });
});
