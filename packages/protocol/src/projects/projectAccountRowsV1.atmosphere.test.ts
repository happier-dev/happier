import { describe, expect, it } from 'vitest';
import { ProjectAccountOrganizationV1Schema, StoredProjectAccountRowPayloadV1Schema } from './projectAccountRowsV1.js';

describe('Project atmosphere organization', () => {
    it('persists an override and drops future presentation fields on stored reads', () => {
        const atmosphere = { source: 'none', planet: { placement: 'corner', style: 'balanced', digits: true },
            picture: { ref: { kind: 'builtin', id: 'p501' }, layout: 'horizon' }, looks: {}, showOn: ['home', 'new-session', 'projects'] };
        expect(ProjectAccountOrganizationV1Schema.safeParse({ label: 'Project', atmosphere }).success).toBe(true);
        expect(ProjectAccountOrganizationV1Schema.safeParse({ atmosphere: 'home' }).success).toBe(true);
        expect(StoredProjectAccountRowPayloadV1Schema.parse({
            key: { kind: 'project-organization', serverId: 'home', projectKey: 'project' },
            value: { atmosphere: { ...atmosphere, future: true } },
        })).toHaveProperty('value.atmosphere', atmosphere);
        const { showOn: _showOn, ...withoutPlaces } = atmosphere;
        expect(StoredProjectAccountRowPayloadV1Schema.parse({
            key: { kind: 'project-organization', serverId: 'home', projectKey: 'project' },
            value: { atmosphere: { ...withoutPlaces, picture: { ...atmosphere.picture, layout: 'wallpaper' } } },
        })).toHaveProperty('value.atmosphere.showOn', ['home', 'new-session', 'projects', 'sessions', 'pages']);
    });
});
