import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol';

import { resolveAgentModelsSettingsAccess } from './resolveAgentModelsSettingsAccess';

describe('resolveAgentModelsSettingsAccess', () => {
    it('keeps absent and current provider settings writable', () => {
        expect(resolveAgentModelsSettingsAccess({ schemaVersion: 7 })).toMatchObject({ writable: true });
        expect(resolveAgentModelsSettingsAccess({
            schemaVersion: 7,
            providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1,
        })).toMatchObject({ writable: true });
    });

    it('makes malformed and future provider settings read-only instead of mutating recovered defaults', () => {
        expect(resolveAgentModelsSettingsAccess({
            schemaVersion: 7,
            providerSettingsV1: { v: 99, connections: [{ id: 'future' }] },
        })).toMatchObject({ writable: false });
        expect(resolveAgentModelsSettingsAccess({
            schemaVersion: 7,
            providerSettingsV1: { v: 1, connections: 'invalid' },
        })).toMatchObject({ writable: false });
    });
});
