import { expect, it } from 'vitest';
import { DATABASE_INSIGHT_SOURCES_POINT_REF_V1 } from '@happier-dev/plugin-sdk/database';
import { PLUGIN_MANIFEST } from './manifest.js';

it('publishes the point external authors target for listing and reading findings', () => {
    const { pluginId, pointId, protocol } = DATABASE_INSIGHT_SOURCES_POINT_REF_V1;

    expect(PLUGIN_MANIFEST.id).toBe(pluginId);
    expect(PLUGIN_MANIFEST.contributes.pluginContributionPoints).toContainEqual(expect.objectContaining({
        id: pointId,
        protocols: expect.arrayContaining([expect.objectContaining({
            ...protocol,
            operations: expect.objectContaining({
                list: expect.objectContaining({ required: true }),
                detail: expect.objectContaining({ required: true }),
            }),
        })]),
    }));
});
