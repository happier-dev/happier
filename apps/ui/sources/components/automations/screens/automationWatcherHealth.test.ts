import { describe, expect, it } from 'vitest';
import type { PluginProjectionV2 } from '@happier-dev/protocol';

import { resolveAutomationEventObserverRuntimeHealth } from './automationWatcherHealth';

function projection(input: Readonly<{
    immutableGenerationId?: string;
    backgroundState?: 'active' | 'unavailable';
    backgroundServiceLocalId?: string;
}> = {}): PluginProjectionV2 {
    const immutableGenerationId = input.immutableGenerationId ?? 'github-generation-current';
    const backgroundState = input.backgroundState ?? 'active';
    const backgroundServiceLocalId = input.backgroundServiceLocalId
        ?? 'automation-repository-event-checkpointed-pull';
    return {
        v: 2,
        generation: 7,
        installedPackagesById: {
            'happier.scm.github': {
                id: 'happier.scm.github',
                displayName: 'GitHub',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'bundled', locator: '@happier-dev/plugins-scm-github' },
                immutableGenerationId,
            },
        },
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {},
        contributionIntrospection: {
            version: 1,
            generation: 7,
            diagnostics: [],
            contributions: [{
                version: 1,
                contribution: {
                    kind: 'localId',
                    pluginId: 'happier.scm.github',
                    family: 'backgroundServices',
                    localId: backgroundServiceLocalId,
                    qualifiedId: `happier.scm.github/backgroundServices/${backgroundServiceLocalId}`,
                },
                progression: { declared: true, normalized: true, merged: true },
                registration: backgroundState === 'active'
                    ? { requirement: 'required', state: 'bound', generation: '7' }
                    : { requirement: 'required', state: 'unavailable', reason: 'Observer stopped' },
                activation: backgroundState === 'active'
                    ? { state: 'active', generation: '7' }
                    : { state: 'dormant' },
                projection: { state: 'projected' },
                consumer: 'daemon',
                platforms: ['cli'],
                diagnostics: [],
            }],
        },
        diagnostics: [],
    } as PluginProjectionV2;
}

describe('Automation Event observer runtime health', () => {
    it('accepts an exact current generation with a live declared observer', () => {
        expect(resolveAutomationEventObserverRuntimeHealth({
            projection: projection(),
            eventPluginId: 'happier.scm.github',
            reporterImmutableGenerationId: 'github-generation-current',
        })).toEqual({ kind: 'current' });
    });

    it('rejects retained status from a replaced immutable generation', () => {
        expect(resolveAutomationEventObserverRuntimeHealth({
            projection: projection(),
            eventPluginId: 'happier.scm.github',
            reporterImmutableGenerationId: 'github-generation-retired',
        })).toEqual({ kind: 'generationReplaced' });
    });

    it('does not let an unrelated same-plugin background service suppress source-owned status', () => {
        expect(resolveAutomationEventObserverRuntimeHealth({
            projection: projection({
                backgroundState: 'unavailable',
                backgroundServiceLocalId: 'unrelated-maintenance-service',
            }),
            eventPluginId: 'happier.scm.github',
            reporterImmutableGenerationId: 'github-generation-current',
        })).toEqual({ kind: 'current' });
    });
});
