import { describe, expect, it } from 'vitest';

import type { AIBackendProfile } from '@/sync/domains/settings/settings';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';

function makeProfile(reqs: AIBackendProfile['envVarRequirements']): AIBackendProfile {
    return {
        id: 'p1',
        name: 'Profile',
        isBuiltIn: false,
        environmentVariables: [],
        compatibility: { claude: true, codex: true, gemini: true },
        envVarRequirements: reqs ?? [],
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    } as any;
}

describe('getMissingRequiredConfigEnvVarNames', () => {
    it('returns [] when profile has no required config requirements', () => {
        const profile = makeProfile([{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }]);
        expect(getMissingRequiredConfigEnvVarNames(profile, { OPENAI_API_KEY: false })).toEqual([]);
    });

    it('returns missing required config env vars when not set in machine env', () => {
        const profile = makeProfile([
            { name: 'AZURE_OPENAI_ENDPOINT', kind: 'config', required: true },
            { name: 'AZURE_OPENAI_API_KEY', kind: 'secret', required: true },
            { name: 'OPTIONAL_CFG', kind: 'config', required: false },
        ]);

        expect(getMissingRequiredConfigEnvVarNames(profile, { AZURE_OPENAI_ENDPOINT: false })).toEqual(['AZURE_OPENAI_ENDPOINT']);
    });

    it('treats true as configured and ignores null/undefined', () => {
        const profile = makeProfile([{ name: 'CFG', kind: 'config', required: true }]);
        expect(getMissingRequiredConfigEnvVarNames(profile, { CFG: true })).toEqual([]);
        expect(getMissingRequiredConfigEnvVarNames(profile, { CFG: null })).toEqual(['CFG']);
        expect(getMissingRequiredConfigEnvVarNames(profile, {})).toEqual(['CFG']);
    });

    it('ignores malformed requirement names and only returns valid required config names', () => {
        const profile = makeProfile([
            { name: '', kind: 'config', required: true } as any,
            { kind: 'config', required: true } as any,
            { name: 'CFG_OK', kind: 'config', required: true },
        ]);
        expect(getMissingRequiredConfigEnvVarNames(profile, { CFG_OK: false })).toEqual(['CFG_OK']);
    });
});
