import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';

import { resolveAgentModelsSettingsAccess } from './resolveAgentModelsSettingsAccess';

describe('resolveAgentModelsSettingsAccess', () => {
    it('requires an authoritative complete row before permitting model effects', () => {
        const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
        expect(resolveAgentModelsSettingsAccess(null)).toMatchObject({ writable: false });
        expect(resolveAgentModelsSettingsAccess({ status: 'loading', data: null })).toMatchObject({ writable: false });
        expect(resolveAgentModelsSettingsAccess({ status: 'ready', data: null })).toMatchObject({ writable: false });
        expect(resolveAgentModelsSettingsAccess({ status: 'ready', data: catalog })).toMatchObject({ writable: true });
    });

    it('retains stale visibility for display while refusing effects on incomplete catalogs', () => {
        const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
        const modelVisibilityByRef = { [serializeModelVisibilityRefV1({ scope: 'agent', agentTargetKey: 'agent:claude',
            providerConnectionId: null, modelId: 'retained' })]: 'hidden' as const };
        expect(resolveAgentModelsSettingsAccess({ status: 'partial', data: { ...catalog, modelVisibilityByRef } }))
            .toMatchObject({ writable: false, settings: { modelVisibilityByRef } });
        expect(resolveAgentModelsSettingsAccess({ status: 'unavailable', data: { ...catalog, modelVisibilityByRef } }))
            .toMatchObject({ writable: false, settings: { modelVisibilityByRef } });
    });
});
