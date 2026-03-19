import { describe, expect, it } from 'vitest';

import {
    buildResumeCapabilityOptionsFromUiState,
} from './registryUiBehavior';
import { makeSettings } from './registryUiBehavior.testHelpers';

describe('buildResumeCapabilityOptionsFromUiState', () => {
    it('uses the current Codex default backend without requiring runtime results', () => {
        const settings = makeSettings({ codexBackendMode: 'appServer' as any });
        expect(buildResumeCapabilityOptionsFromUiState({
            settings,
            results: undefined,
        })).toEqual({
            accountSettings: settings,
        });
    });
});
