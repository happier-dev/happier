import { describe, expect, it } from 'vitest';

import { resolvePluginActionCaller } from './actionCaller';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';

describe('resolvePluginActionCaller', () => {
    it('preserves only a canonically valid host-stamped immutable generation', () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.plugin');

        expect(resolvePluginActionCaller({
            plugin: { id: 'acme.plugin' },
            immutableGenerationId: ' generation-1 ',
            resolveCurrentPluginMaterializationRef:
                materialization.resolveCurrentPluginMaterializationRef,
        })).toBeNull();

        expect(resolvePluginActionCaller({
            plugin: { id: 'acme.plugin' },
            contribution: { id: 'action' },
            immutableGenerationId: 'generation-1',
            resolveCurrentPluginMaterializationRef:
                materialization.resolveCurrentPluginMaterializationRef,
        })).toEqual({
            kind: 'plugin',
            pluginId: 'acme.plugin',
            contributionLocalId: 'action',
            immutableGenerationId: 'generation-1',
            materialization: materialization.materialization,
        });
    });
});
