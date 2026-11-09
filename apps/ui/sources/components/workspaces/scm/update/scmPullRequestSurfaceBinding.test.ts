import { describe, expect, it } from 'vitest';
import { normalizePluginUiInlineSurfaceBindingV1, PluginUiInlineSurfaceBindingV1Schema } from '@happier-dev/protocol/plugins/ui';
import { ScmPullRequestSummarySchema } from '@happier-dev/protocol/scm/pullRequests';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { createPluginUiResourceProjection } from '@/dev/testkit/fixtures/pluginUiResourceProjection';
import { requestOpenResource } from '@/utils/url/openResource';

import { resolveScmPullRequestSurfaceBinding } from './scmPullRequestSurfaceBinding';

function projection(pluginIds: readonly string[], targetKind: 'session' | 'app' = 'session') {
    return normalizePluginUiProjection({
        v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, 
        resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(pluginIds.map((pluginId) => {
            const normalized = normalizePluginUiInlineSurfaceBindingV1({
                pluginId, surfaceId: 'pull-request', rendererId: 'pr-renderer',
                role: 'scmPullRequest', target: { kind: targetKind },
            });
            if (!normalized) throw new Error('Expected admitted SCM inline binding');
            const binding = PluginUiInlineSurfaceBindingV1Schema.parse(normalized);
            const id = `surfacePlacement:${pluginId}:pull-request`;
            const placement: NonNullable<PluginProjectionV2['familiesById']['pluginUi']>['entriesById'][string] = {
                id, pluginId, occurrenceId: `${pluginId}-occurrence`, contributionKind: 'surfacePlacement',
                descriptorId: 'pull-request', binding, target: binding.target,
                renderer: { kind: 'declarative', contributionId: 'pr-renderer' }, display: { title: 'Pull request' },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            };
            return [id, placement];
        })) } },
    });
}

const detected = ScmPullRequestSummarySchema.parse({
    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/repo' },
    number: 42, url: 'https://github.com/acme/repo/pull/42', title: 'Retain repository context',
    baseBranch: 'main', headBranch: 'topic', state: 'open', checks: { state: 'pending' },
});

describe('SCM pull request surface binding', () => {
    it.each(['session', 'app'] as const)('keeps the sole Triage card and CI destination navigable together in %s', async targetKind => {
        const card = projection(['happier.triage'], targetKind);
        const runUrl = 'https://github.com/acme/repo/actions/runs/42';
        const run = createPluginUiResourceProjection(true, targetKind, 'destination', {
            kind: 'ciRun', urlPattern: '^https://github[.]com/acme/repo/actions/runs/[0-9]+$', destination: 'details',
        });
        const combined = { ...card, surfacePlacementsById: { ...card.surfacePlacementsById, ...run.surfacePlacementsById } };
        expect(resolveScmPullRequestSurfaceBinding({ projection: combined, targetKind })?.placement.pluginId).toBe('happier.triage');
        const launches: unknown[] = [];
        const external: string[] = [];
        await requestOpenResource({ kind: 'ciRun', url: runUrl }, { projection: combined,
            navigation: { targetKind, openSurface: request => { launches.push(request); return { ok: true }; } },
            openExternal: async url => { external.push(url); return true; } });
        expect(launches).toEqual([{ destination: { pluginId: 'acme.forge', localId: 'details' },
            ...(targetKind === 'session' ? { instanceKey: runUrl } : {}), input: { resource: { kind: 'ciRun', url: runUrl } } }]);
        expect(external).toEqual([]);
    });

    it('carries the exact snapshot URL and discovery identity to an external admitted Session surface', () => {
        const mount = resolveScmPullRequestSurfaceBinding({ projection: projection(['acme.pr']), pullRequest: detected, targetKind: 'session' });
        expect(mount?.placement.pluginId).toBe('acme.pr');
        expect(mount?.launchInput.pullRequest).toBe(detected);
        expect(mount?.launchInput.pullRequest?.url).toBe(detected.url);
        expect(mount?.inlineMount).toEqual({ role: 'scmPullRequest', presentation: 'content' });
    });

    it('mounts a Session contribution without a branch hint and carries created intent through the same input', () => {
        const mount = resolveScmPullRequestSurfaceBinding({ projection: projection(['acme.pr']), targetKind: 'session' });
        expect(mount?.placement.pluginId).toBe('acme.pr');
        expect(mount?.launchInput).toEqual({});
        expect(resolveScmPullRequestSurfaceBinding({ projection: projection(['acme.pr']), pullRequest: detected, origin: 'createdHere', targetKind: 'session' })?.launchInput)
            .toEqual({ pullRequest: detected, origin: 'createdHere' });
    });

    it('does not appoint a relationship owner from ambiguous or disabled contributors', () => {
        expect(resolveScmPullRequestSurfaceBinding({ projection: projection(['acme.one', 'acme.two']), pullRequest: detected, targetKind: 'session' })).toBeNull();
        expect(resolveScmPullRequestSurfaceBinding({ projection: projection([]), pullRequest: null, targetKind: 'session' })).toBeNull();
        expect(resolveScmPullRequestSurfaceBinding({ projection: null, pullRequest: detected, targetKind: 'session' })).toBeNull();
    });

    it('keeps Project-only discovery in app context without borrowing a Session binding', () => {
        const projected = projection(['acme.pr'], 'app');
        expect(resolveScmPullRequestSurfaceBinding({ projection: projected, pullRequest: detected, targetKind: 'session' })).toBeNull();
        const mount = resolveScmPullRequestSurfaceBinding({ projection: projected, pullRequest: detected, targetKind: 'app' });
        expect(mount?.placement.binding.targetKind).toBe('app');
        expect(mount?.launchInput).not.toHaveProperty('sessionId');
    });
});
