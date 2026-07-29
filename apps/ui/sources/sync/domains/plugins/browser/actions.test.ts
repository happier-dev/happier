import { describe, expect, it, vi } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';

import {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    canUsePluginBrowserProjectionEntry,
    executePluginBrowserAction,
    normalizePluginBrowserProjection,
    resolvePluginBrowserProjectionState,
    selectPluginBrowserToolbarActions,
} from './actions';

const display = {
    title: 'Preview',
    addressLabel: 'https://preview.example.test/',
} as const;

const target = {
    kind: 'externalUrl',
    targetId: 'browserTarget:acme.preview:preview-target',
    url: 'https://preview.example.test/',
} as const;

function createProjection(): PluginProjectionV2 {
    return {
        v: 2,
        generation: 14,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {
            'acme.preview/open-preview': {
                id: 'open-preview',
                pluginId: 'acme.preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placement: 'detailsPanel',
                dangerLevel: 'safe',
                available: true,
            },
        },
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginBrowser: {
                family: 'pluginBrowser',
                entriesById: {
                    'browserTarget:acme.preview:preview-target': {
                        id: 'browserTarget:acme.preview:preview-target',
                        pluginId: 'acme.preview',
                        contributionKind: 'browserTarget',
                        contributionId: 'preview-target',
                        target,
                        display,
                        currentUrl: 'https://preview.example.test/',
                        launchMode: 'currentView',
                        profileMode: 'session',
                        availability: {
                            when: {
                                fact: 'host.feature',
                                operator: 'enabled',
                                value: 'browser.viewTargets',
                            },
                        },
                    },
                    'browserAction:acme.preview:open-preview': {
                        id: 'browserAction:acme.preview:open-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'browserAction',
                        contributionId: 'open-preview',
                        qualifiedActionId: 'acme.preview/open-preview',
                        targetId: 'browserTarget:acme.preview:preview-target',
                        placement: 'toolbar',
                        display: { title: 'Open preview', iconToken: 'open-outline' },
                        availability: {
                            when: {
                                fact: 'host.feature',
                                operator: 'enabled',
                                value: 'browser.viewTargets',
                            },
                        },
                    },
                    'unknown:acme.preview': {
                        id: 'unknown:acme.preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'futureBrowserEntry',
                    },
                },
            },
        },
        diagnostics: [],
    };
}

describe('plugin browser projection normalization', () => {
    it('normalizes plugin browser targets and actions into stable lookup maps', () => {
        const model = normalizePluginBrowserProjection(createProjection());

        expect(model.generation).toBe(14);
        expect(model.targetsById['browserTarget:acme.preview:preview-target']).toMatchObject({
            pluginId: 'acme.preview',
            contributionKind: 'browserTarget',
            target: { kind: 'externalUrl', url: 'https://preview.example.test/' },
            launchMode: 'currentView',
            profileMode: 'session',
        });
        expect(model.actionsById['browserAction:acme.preview:open-preview']).toMatchObject({
            pluginId: 'acme.preview',
            contributionKind: 'browserAction',
            qualifiedActionId: 'acme.preview/open-preview',
            placement: 'toolbar',
            availability: {
                when: {
                    fact: 'host.feature',
                    operator: 'enabled',
                    value: 'browser.viewTargets',
                },
            },
        });
        expect(model.unknownEntriesById['unknown:acme.preview']).toMatchObject({
            contributionKind: 'futureBrowserEntry',
        });
    });

    it('rejects mismatched, undeclared, and dangling browser projection identities', () => {
        const projection = createProjection();
        const family = projection.familiesById.pluginBrowser!;
        const validTarget = family.entriesById['browserTarget:acme.preview:preview-target']!;
        const validAction = family.entriesById['browserAction:acme.preview:open-preview']!;
        const malformed = {
            ...projection,
            familiesById: {
                ...projection.familiesById,
                pluginBrowser: {
                    ...family,
                    entriesById: {
                        ...family.entriesById,
                        'browserTarget:acme.preview:mismatched-target': {
                            ...validTarget,
                            id: 'browserTarget:acme.preview:mismatched-target',
                            contributionId: 'different-target',
                            target: {
                                ...target,
                                targetId: 'browserTarget:acme.preview:mismatched-target',
                            },
                        },
                        'browserAction:acme.preview:undeclared-action': {
                            ...validAction,
                            id: 'browserAction:acme.preview:undeclared-action',
                            contributionId: 'undeclared-action',
                            qualifiedActionId: 'acme.preview/not-declared',
                        },
                        'browserAction:acme.preview:dangling-target': {
                            ...validAction,
                            id: 'browserAction:acme.preview:dangling-target',
                            contributionId: 'dangling-target',
                            targetId: 'browserTarget:acme.preview:not-declared',
                        },
                        'browserAction:acme.preview:wire-alias': {
                            ...validAction,
                            display: { title: 'Aliased spoof' },
                        },
                    },
                },
            },
        } satisfies PluginProjectionV2;

        const model = normalizePluginBrowserProjection(malformed);

        expect(Object.keys(model.targetsById)).toEqual([
            'browserTarget:acme.preview:preview-target',
        ]);
        expect(Object.keys(model.actionsById)).toEqual([
            'browserAction:acme.preview:open-preview',
        ]);
        expect(model.actionsById['browserAction:acme.preview:open-preview']?.display.title)
            .toBe('Open preview');
        expect(model.unknownEntriesById).toMatchObject({
            'browserTarget:acme.preview:mismatched-target': {
                contributionKind: 'browserTarget',
            },
            'browserAction:acme.preview:undeclared-action': {
                contributionKind: 'browserAction',
            },
            'browserAction:acme.preview:dangling-target': {
                contributionKind: 'browserAction',
            },
            'browserAction:acme.preview:open-preview': {
                contributionKind: 'browserAction',
                display: { title: 'Aliased spoof' },
            },
        });
    });

    it('keeps the previous model while a projection refresh is unresolved', () => {
        const previous = normalizePluginBrowserProjection(createProjection());

        expect(resolvePluginBrowserProjectionState(previous, null)).toBe(previous);
    });

    it('clears the previous model when an authoritative projection refresh is unsupported', () => {
        const previous = normalizePluginBrowserProjection(createProjection());

        expect(resolvePluginBrowserProjectionState(previous, { v: 1, agentsById: {}, backendsById: {} }))
            .toBe(EMPTY_PLUGIN_BROWSER_PROJECTION);
    });

    it('fails closed for browser entries with unevaluated policy fields', () => {
        const model = normalizePluginBrowserProjection(createProjection());

        expect(canUsePluginBrowserProjectionEntry(model.targetsById['browserTarget:acme.preview:preview-target'])).toBe(false);
        expect(canUsePluginBrowserProjectionEntry(model.actionsById['browserAction:acme.preview:open-preview'])).toBe(false);
        expect(canUsePluginBrowserProjectionEntry(model.actionsById['browserAction:acme.preview:missing'])).toBe(false);
        expect(canUsePluginBrowserProjectionEntry({
            id: 'browserAction:acme.preview:plain',
            pluginId: 'acme.preview',
            contributionKind: 'browserAction',
            contributionId: 'plain',
            qualifiedActionId: 'acme.preview/plain',
            targetId: 'browserTarget:acme.preview:preview-target',
            placement: 'toolbar',
            display: { title: 'Plain' },
        })).toBe(true);
        expect(canUsePluginBrowserProjectionEntry({
            id: 'browserAction:acme.preview:read-only',
            pluginId: 'acme.preview',
            contributionKind: 'browserAction',
            contributionId: 'read-only',
            qualifiedActionId: 'acme.preview/read-only',
            targetId: 'browserTarget:acme.preview:preview-target',
            placement: 'toolbar',
            display: { title: 'Read only' },
            availability: {
                disabledWhen: { fact: 'host.feature', operator: 'enabled', value: 'preview.readOnly' },
                disabledReason: 'Preview is read-only',
            },
        }, {
            isFeatureEnabled: (id) => id === 'preview.readOnly',
        })).toBe(false);
    });

    it('executes a browser presentation only through the generation-leased canonical action RPC', async () => {
        const model = normalizePluginBrowserProjection(createProjection());
        const action = model.actionsById['browserAction:acme.preview:open-preview'];
        const execute = vi.fn(async () => ({ supported: true as const, result: { ok: true as const, result: null } }));

        await expect(executePluginBrowserAction({
            action,
            generation: model.generation,
            machineId: 'machine-1',
            serverId: 'server-a',
            sessionId: 'session-1',
            input: {
                browserSessionId: 'browser-session-1',
                viewId: 'view-1',
                targetId: action.targetId,
            },
            policyContext: {
                profileMode: 'session',
                isFeatureEnabled: () => true,
            },
            execute,
        })).resolves.toEqual({ ok: true, result: null });

        expect(execute).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '14',
            qualifiedActionId: 'acme.preview/open-preview',
            input: {
                browserSessionId: 'browser-session-1',
                viewId: 'view-1',
                targetId: 'browserTarget:acme.preview:preview-target',
            },
            sessionId: 'session-1',
            executionSurface: 'ui',
        });
    });

    it('selects only toolbar actions bound to the active browser target', () => {
        const model = normalizePluginBrowserProjection(createProjection());

        expect(selectPluginBrowserToolbarActions({
            projection: model,
            targetId: 'browserTarget:acme.preview:preview-target',
            policyContext: {
                profileMode: 'session',
                isFeatureEnabled: () => true,
            },
        }).map((action) => action.qualifiedActionId)).toEqual(['acme.preview/open-preview']);
        expect(selectPluginBrowserToolbarActions({
            projection: model,
            targetId: 'browserTarget:acme.preview:other-target',
        })).toEqual([]);
    });
});
