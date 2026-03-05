import { describe, expect, it } from 'vitest';

import {
    buildResumeCapabilityOptionsFromUiState,
} from './registryUiBehavior';
import { makeSettings } from './registryUiBehavior.testHelpers';

describe('buildResumeCapabilityOptionsFromUiState', () => {
    it('treats Codex sessions as resumable in ACP mode without requiring any runtime results', () => {
        const settings = makeSettings({ codexBackendMode: 'acp' });
        expect(buildResumeCapabilityOptionsFromUiState({
            settings,
            results: undefined,
        })).toEqual({
            accountSettings: settings,
        });
    });
});
