import { describe, expect, it } from 'vitest';

import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';
import type { ResolvedSettingsContribution } from '@/plugins/projection/registry/types';

import { resolveLocalSettingsDeclarations } from './localSettingsContributions';

function settingsContribution(
    id: string,
    scope: PluginSettingsContributionV2['scope'],
    fieldSchema: PluginSettingsContributionV2['fields'][number]['schema'],
): ResolvedSettingsContribution {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: 'acme.settings',
        definition: {
            id,
            version: 1,
            title: id,
            target: { kind: 'plugin' },
            scope,
            fields: [{ id: 'shared', title: 'Shared', schema: fieldSchema }],
            presentation: { sections: [], subagentSections: [] },
        },
    };
}

describe('local settings contribution admission', () => {
    it('consumes already-admitted account and daemon settings with the same nonsecret local id', () => {
        expect(resolveLocalSettingsDeclarations({
            settings: [
                settingsContribution('account-preferences', 'account', { type: 'string' }),
                settingsContribution('daemon-preferences', 'daemon', { type: 'object', additionalProperties: true }),
            ],
        }).map((declaration) => ({
            id: declaration.definition.id,
            scope: declaration.definition.scope,
            fieldId: declaration.definition.fields[0]?.id,
        }))).toEqual([
            { id: 'account-preferences', scope: 'account', fieldId: 'shared' },
            { id: 'daemon-preferences', scope: 'daemon', fieldId: 'shared' },
        ]);
    });
});
