import { describe, expect, it } from 'vitest';

import {
    appendAiLaunchProfile,
    projectAiLaunchProfileForLegacyUi,
    readUiAiLaunchProfileSnapshot,
    readUiAiLaunchProfilesForLegacyUi,
    readUiAiLaunchProfiles,
    removeAiLaunchProfile,
    replaceAiLaunchProfile,
} from './aiLaunchProfileCollection';

const legacy = { id: 'legacy', name: 'Legacy', environmentVariables: [], createdAt: 1, updatedAt: 1 };
const slim = {
    v: 2 as const,
    id: 'slim',
    name: 'Slim',
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {},
    createdAt: 2,
    updatedAt: 2,
};
const future = { v: 99, id: 'future', opaque: { untouched: true } };
const malformed = { v: 2, id: '', malformed: true };

describe('AI launch profile UI collection', () => {
    it('returns only executable legacy and slim rows', () => {
        expect(readUiAiLaunchProfiles([legacy, slim, future, malformed]).map((profile) => profile.id)).toEqual(['legacy', 'slim']);
    });

    it('reports retained newer-schema rows beside the executable projection', () => {
        const snapshot = readUiAiLaunchProfileSnapshot([legacy, slim, future, malformed]);
        expect(snapshot.profiles.map((profile) => profile.id)).toEqual(['legacy', 'slim']);
        expect(snapshot.unreadableCount).toBe(2);
    });

    it('projects only current profile rows for legacy UI consumers', () => {
        expect(readUiAiLaunchProfilesForLegacyUi([legacy, slim, future, malformed]).map((profile) => ({
            id: profile.id,
            name: profile.name,
        }))).toEqual([
            { id: 'legacy', name: 'Legacy' },
            { id: 'slim', name: 'Slim' },
        ]);
    });

    it('projects slim rows for the existing list without reintroducing secret/routing ownership', () => {
        const projected = projectAiLaunchProfileForLegacyUi(slim);
        expect(projected).toMatchObject({
            id: 'slim',
            environmentVariables: [],
            envVarRequirements: [],
            isBuiltIn: false,
            compatibilityByTargetKey: {},
        });
        expect(projected).not.toHaveProperty('v');
    });

    it('does not expose the obsolete model pin from a persisted historical Gemini row', () => {
        const [profile] = readUiAiLaunchProfiles([{
            id: 'gemini-vertex',
            name: 'Gemini (Vertex AI)',
            environmentVariables: [
                { name: 'GOOGLE_GENAI_USE_VERTEXAI', value: '1' },
                { name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' },
            ],
            createdAt: 1,
            updatedAt: 1,
        }]);

        expect(profile && !('v' in profile) ? profile.environmentVariables : []).toEqual([
            { name: 'GOOGLE_GENAI_USE_VERTEXAI', value: '1' },
        ]);
    });

    it('replaces and removes executable rows without rewriting opaque or untouched raw rows', () => {
        const raw = [legacy, slim, future, malformed];
        const replacement = { ...slim, name: 'Updated', updatedAt: 3 };
        const replaced = replaceAiLaunchProfile(raw, 'slim', replacement);
        expect(replaced).toEqual([legacy, replacement, future, malformed]);
        expect(replaced[0]).toBe(legacy);
        expect(replaced[2]).toBe(future);
        expect(removeAiLaunchProfile(replaced, 'legacy')).toEqual([replacement, future, malformed]);
    });

    it('appends without normalizing the retained collection and rejects executable id collisions', () => {
        const raw = [legacy, future];
        expect(appendAiLaunchProfile(raw, slim)).toEqual([legacy, future, slim]);
        expect(() => appendAiLaunchProfile(raw, { ...slim, id: 'legacy' })).toThrow(/already exists/i);
    });
});
