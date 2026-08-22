import { describe, expect, it } from 'vitest';

import { projectParameterFreeRoute } from './parameterFreeRouteProjection';

describe('projectParameterFreeRoute', () => {
    it('gives the root index route the incumbent stable home identity', () => {
        const projection = projectParameterFreeRoute(['(app)']);

        expect(projection).toEqual({
            route: 'home',
            segments: [],
        });
    });

    it.each([
        {
            name: 'session detail and nested dynamic file patterns',
            segments: ['(app)', 'session', '[id]', 'runs', '[runId]'],
            expected: 'session/:id/runs/:id',
        },
        {
            name: 'automations static creation sibling',
            segments: ['(app)', 'automations', 'new'],
            expected: 'automations/new',
        },
        {
            name: 'artifacts static creation sibling',
            segments: ['(app)', 'artifacts', 'new'],
            expected: 'artifacts/new',
        },
        {
            name: 'provider static creation sibling',
            segments: ['(app)', 'settings', 'providers', 'new'],
            expected: 'settings/providers/new',
        },
        {
            name: 'theme import and export siblings',
            segments: ['(app)', 'settings', 'appearance', 'themes', 'import'],
            expected: 'settings/appearance/themes/import',
        },
        {
            name: 'prompt document static creation sibling',
            segments: ['(app)', 'settings', 'prompts', 'docs', 'new'],
            expected: 'settings/prompts/docs/new',
        },
        {
            name: 'prompt skill static creation sibling',
            segments: ['(app)', 'settings', 'prompts', 'skills', 'new'],
            expected: 'settings/prompts/skills/new',
        },
        {
            name: 'prompt template static creation sibling',
            segments: ['(app)', 'settings', 'prompts', 'templates', 'new'],
            expected: 'settings/prompts/templates/new',
        },
        {
            name: 'machine detail file pattern',
            segments: ['(app)', 'machine', '[id]', 'terminal'],
            expected: 'machine/:id/terminal',
        },
        {
            name: 'project detail file pattern',
            segments: ['(app)', 'projects', '[workspaceRefId]', 'details'],
            expected: 'projects/:id/details',
        },
        {
            name: 'automation and run detail file patterns',
            segments: ['(app)', 'automations', '[id]', 'runs', '[runId]'],
            expected: 'automations/:id/runs/:id',
        },
        {
            name: 'artifact editor detail file pattern',
            segments: ['(app)', 'artifacts', 'edit', '[id]'],
            expected: 'artifacts/edit/:id',
        },
        {
            name: 'inbox approval detail file pattern',
            segments: ['(app)', 'inbox', 'approvals', '[id]'],
            expected: 'inbox/approvals/:id',
        },
        {
            name: 'OAuth provider detail file pattern',
            segments: ['(app)', 'oauth', '[provider]'],
            expected: 'oauth/:id',
        },
        {
            name: 'share and user detail file patterns',
            segments: ['(app)', 'share', '[token]', 'user', '[id]'],
            expected: 'share/:id/user/:id',
        },
        {
            name: 'plugin page identity and plugin-owned subpath patterns',
            segments: ['(app)', 'plugins', '[pluginId]', '[localId]', '[...subPath]'],
            expected: 'plugins/:id/:id/:id',
        },
        {
            name: 'settings identity leaves from file patterns',
            segments: ['(app)', 'settings', 'plugins', '[pluginId]', '[pageId]'],
            expected: 'settings/plugins/:id/:id',
        },
        {
            name: 'settings static route',
            segments: ['(app)', 'settings', 'voice', 'privacy'],
            expected: 'settings/voice/privacy',
        },
        {
            name: 'query fragments and dynamic file patterns',
            segments: ['(app)', 'settings', 'providers', '[connectionId]?access=secret#fragment'],
            expected: 'settings/providers/:id',
        },
        {
            name: 'optional catch-all file pattern',
            segments: ['(app)', 'plugins', '[pluginId]', '[localId]', '[[...subPath]]'],
            expected: 'plugins/:id/:id/:id',
        },
        {
            name: 'new static file segments without a route catalog entry',
            segments: ['(app)', 'future-static-screen'],
            expected: 'future-static-screen',
        },
    ])('remains parameter-free for $name', ({ segments, expected }) => {
        const projection = projectParameterFreeRoute(segments);

        expect(projection.route).toBe(expected);
        expect(projection.segments).toEqual(expected.split('/'));
        expect(projection.route).not.toContain('work');
        expect(projection.route).not.toContain('calendar');
        expect(projection.route).not.toContain('secret');
    });
});
