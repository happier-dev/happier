import { describe, expect, it } from 'vitest';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';

import {
    projectCurrentSecretBindingsByProfileId,
} from '@/sync/domains/settings/secretBindings';

function createPublishedProfile(secretBindings: Record<string, string>): AiLaunchProfile {
    return { v: 2, id: 'published', name: 'Published', extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
        createdAt: 1, updatedAt: 1, envVarRequirements: [{ name: 'TOKEN', kind: 'secret', required: true }],
        artifactId: 'document', secretBindings };
}

describe('Profile secret binding projection', () => {
    it('projects moved Saved Secret references from hydrated V2 profile documents without values', () => {
        const profile = createPublishedProfile({ TOKEN: 'happier:shared-secret:v1:deploy' });
        expect(projectCurrentSecretBindingsByProfileId([profile]))
            .toEqual({ published: { TOKEN: 'happier:shared-secret:v1:deploy' } });
    });

    it('keeps admitted profile bindings without requiring legacy Saved Secret material', () => {
        const profile = createPublishedProfile({ TOKEN: 'destination-personal-secret' });
        expect(projectCurrentSecretBindingsByProfileId([profile]))
            .toEqual({ published: { TOKEN: 'destination-personal-secret' } });
    });

    it('normalizes declared keys and excludes malformed or undeclared references from the runtime view', () => {
        expect(projectCurrentSecretBindingsByProfileId([
            createPublishedProfile({ token: 'personal-secret', UNDECLARED: 'personal-secret' }),
            { ...createPublishedProfile({ TOKEN: 'happier:shared-secret:v1:' }), id: 'malformed' },
        ])).toEqual({ published: { TOKEN: 'personal-secret' } });
    });

});
