import { describe, expect, it } from 'vitest';

import type {
    OpenableContentMetadataV1,
    PluginOpenableContentViewerContributionV1,
    WorkspaceFileViewerPreferencesV1,
} from '@happier-dev/protocol';
import { accountSettingsParse, serializeOpenableContentPreferenceSelectorV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type {
    PluginUiOpenableContentViewerProjection,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

import {
    isWorkspaceFileOpenableContentViewerEligible,
    resolveWorkspaceFileViewer,
    resolveWorkspaceFileViewerCandidates,
    resolveWorkspaceFileViewerChoiceModel,
    type WorkspaceFileViewerCandidate,
} from './resolveWorkspaceFileViewer';

const markdownMetadata: OpenableContentMetadataV1 = {
    contentClass: 'text',
    mimeType: 'text/markdown',
    extension: '.md',
};

function viewer(input: Readonly<{
    id: string;
    mimeTypes?: readonly string[];
    extensions?: readonly string[];
}>): PluginOpenableContentViewerContributionV1 {
    return {
        id: input.id,
        destination: `${input.id}-view`,
        contentClasses: ['text'],
        ...(input.mimeTypes ? { mimeTypes: [...input.mimeTypes] } : {}),
        ...(input.extensions ? { extensions: [...input.extensions] } : {}),
    };
}

function candidate(input: Readonly<{
    pluginId: string;
    viewer: PluginOpenableContentViewerContributionV1;
    instancePolicy?: 'singleton' | 'multiple';
}>): WorkspaceFileViewerCandidate {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: input.pluginId,
        destinationId: input.viewer.destination,
        rendererId: `${input.viewer.id}-renderer`,
        container: 'detailsTab',
        target: { kind: 'session' },
        instancePolicy: input.instancePolicy,
    });
    if (!binding) throw new Error('test viewer destination binding must be admitted');
    const entry = {
        id: `openableContentViewer:${input.pluginId}:${input.viewer.id}`,
        pluginId: input.pluginId,
        contributionKind: 'openableContentViewer',
        descriptorId: input.viewer.id,
        identity: { pluginId: input.pluginId, localId: input.viewer.id },
        viewer: {
            contentClasses: input.viewer.contentClasses,
            ...(input.viewer.mimeTypes === undefined ? {} : { mimeTypes: input.viewer.mimeTypes }),
            ...(input.viewer.extensions === undefined ? {} : { extensions: input.viewer.extensions }),
        },
        destination: { pluginId: input.pluginId, localId: input.viewer.destination },
    } satisfies PluginUiOpenableContentViewerProjection;
    const placement = {
        id: `surfacePlacement:${input.pluginId}:${input.viewer.destination}`,
        pluginId: input.pluginId,
        occurrenceId: `${input.pluginId}-occurrence`,
        contributionKind: 'surfacePlacement',
        descriptorId: input.viewer.destination,
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: `${input.viewer.id}-renderer` },
        display: { developerFallback: input.viewer.id },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection;
    return { entry, placement };
}

function preferences(selections: WorkspaceFileViewerPreferencesV1['selections']): WorkspaceFileViewerPreferencesV1 {
    return { v: 1, selections };
}

describe('resolveWorkspaceFileViewer', () => {
    it('offers a tab-local built-in text alternative without changing the Account preference', () => {
        const stored = preferences({});
        const model = resolveWorkspaceFileViewerChoiceModel({
            metadata: { contentClass: 'binary', mimeType: 'application/octet-stream', extension: '.bin' },
            preferences: stored, availablePluginViewers: [], builtinViewer: 'text',
        });
        expect(model.choices.slice(0, 2)).toEqual([{ kind: 'builtin' }, { kind: 'text' }]);
        expect(model.selected).toEqual({ kind: 'text' });
        expect(stored.selections).toEqual({});
    });
    it('offers Open as text only where the built-in view is not already the text', () => {
        const text = resolveWorkspaceFileViewerChoiceModel({
            metadata: markdownMetadata, preferences: preferences({}), availablePluginViewers: [],
        });
        // A text file's Default already reads as text (Source): a second text entry would be noise on every file.
        expect(text.choices).toEqual([{ kind: 'builtin' }]);
        const opaque = resolveWorkspaceFileViewerChoiceModel({
            metadata: { contentClass: 'binary', mimeType: 'application/octet-stream', extension: '.bin' },
            preferences: preferences({}), availablePluginViewers: [],
        });
        expect(opaque.choices).toEqual([{ kind: 'builtin' }, { kind: 'text' }]);
        const picture = resolveWorkspaceFileViewerChoiceModel({
            metadata: { contentClass: 'image', mimeType: 'image/png', extension: '.png' },
            preferences: preferences({}), availablePluginViewers: [],
        });
        expect(picture.choices).toEqual([{ kind: 'builtin' }]);
        // A PDF, a video or a sound is binary bytes the built-in view already shows (FV5, FV6), so no text band.
        for (const mimeType of ['application/pdf', 'video/mp4', 'audio/wav']) {
            const document = resolveWorkspaceFileViewerChoiceModel({
                metadata: { contentClass: 'binary', mimeType }, preferences: preferences({}), availablePluginViewers: [],
            });
            expect(document.choices, mimeType).toEqual([{ kind: 'builtin' }]);
        }
    });
    it('excludes both live and first-hydration persisted editor scopes', () => {
        expect(isWorkspaceFileOpenableContentViewerEligible({
            isEditingFile: true,
            hasPersistedEditingDraft: false,
        })).toBe(false);
        expect(isWorkspaceFileOpenableContentViewerEligible({
            isEditingFile: false,
            hasPersistedEditingDraft: true,
        })).toBe(false);
        expect(isWorkspaceFileOpenableContentViewerEligible({
            isEditingFile: false,
            hasPersistedEditingDraft: false,
        })).toBe(true);
    });

    it('orders matching plugin choices deterministically without making one authoritative by default', () => {
        const extensionViewer = viewer({ id: 'extension', extensions: ['.md'] });
        const exactMimeViewer = viewer({ id: 'markdown', mimeTypes: ['text/markdown'] });

        const model = resolveWorkspaceFileViewerChoiceModel({
            metadata: markdownMetadata,
            preferences: preferences({}),
            availablePluginViewers: [
                candidate({ pluginId: 'plugin.zeta', viewer: extensionViewer }),
                candidate({ pluginId: 'plugin.alpha', viewer: exactMimeViewer }),
            ],
        });

        expect(model.selected).toEqual({ kind: 'builtin' });
        expect(model.choices).toMatchObject([
            { kind: 'builtin' },
            {
                kind: 'plugin',
                candidate: {
                    identity: { pluginId: 'plugin.alpha', localId: 'markdown' },
                    match: { selector: 'mimeExact', specificity: 3 },
                },
            },
            { kind: 'plugin', candidate: { identity: { pluginId: 'plugin.zeta', localId: 'extension' } } },
        ]);
    });

    it('breaks equal-strength choice ordering by qualified identity rather than install order', () => {
        const beta = viewer({ id: 'markdown', extensions: ['.md'] });
        const alpha = viewer({ id: 'markdown', extensions: ['.md'] });

        const model = resolveWorkspaceFileViewerChoiceModel({
            metadata: markdownMetadata,
            preferences: preferences({}),
            availablePluginViewers: [
                candidate({ pluginId: 'plugin.beta', viewer: beta }),
                candidate({ pluginId: 'plugin.alpha', viewer: alpha }),
            ],
        });

        expect(model.selected).toEqual({ kind: 'builtin' });
        expect(model.choices).toMatchObject([
            { kind: 'builtin' },
            { kind: 'plugin', candidate: { identity: { pluginId: 'plugin.alpha', localId: 'markdown' } } },
            { kind: 'plugin', candidate: { identity: { pluginId: 'plugin.beta', localId: 'markdown' } } },
        ]);
    });

    it('honors an available Settings-owned plugin preference over the deterministic match', () => {
        const preferenceKey = serializeOpenableContentPreferenceSelectorV1({ kind: 'extension', value: '.md' });
        const extensionViewer = viewer({ id: 'extension', extensions: ['.md'] });
        const exactMimeViewer = viewer({ id: 'markdown', mimeTypes: ['text/markdown'] });

        const selected = resolveWorkspaceFileViewer({
            metadata: markdownMetadata,
            preferences: preferences({
                [preferenceKey]: { kind: 'plugin', pluginId: 'plugin.zeta', contributionLocalId: 'extension' },
            }),
            availablePluginViewers: [
                candidate({ pluginId: 'plugin.alpha', viewer: exactMimeViewer }),
                candidate({ pluginId: 'plugin.zeta', viewer: extensionViewer }),
            ],
        });

        expect(selected).toMatchObject({
            kind: 'plugin',
            candidate: { identity: { pluginId: 'plugin.zeta', localId: 'extension' } },
        });
    });

    it('keeps an unavailable plugin preference intact while visibly falling back to the built-in viewer', () => {
        const preferenceKey = serializeOpenableContentPreferenceSelectorV1({ kind: 'mime', value: 'text/markdown' });
        const source = preferences({
            ...Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
                serializeOpenableContentPreferenceSelectorV1({ kind: 'extension', value: `.${'x'.repeat(250)}${index}` }),
                { kind: 'plugin', pluginId: 'plugin.retired', contributionLocalId: 'markdown' },
            ])),
            [preferenceKey]: { kind: 'plugin', pluginId: 'plugin.retired', contributionLocalId: 'markdown' },
        });
        expect(new TextEncoder().encode(JSON.stringify(source)).byteLength).toBeGreaterThan(16 * 1024);
        const storedPreferences = Object.freeze(accountSettingsParse(JSON.parse(JSON.stringify({
            workspaceFileViewerPreferencesV1: source,
        }))).workspaceFileViewerPreferencesV1);
        expect(storedPreferences).toEqual(source);
        const otherwiseMatchingViewer = viewer({
            id: 'markdown',
            mimeTypes: ['text/markdown'],
        });

        const selected = resolveWorkspaceFileViewer({
            metadata: markdownMetadata,
            preferences: storedPreferences,
            availablePluginViewers: [
                candidate({ pluginId: 'plugin.available', viewer: otherwiseMatchingViewer }),
            ],
        });

        expect(selected).toEqual({ kind: 'builtin' });
        expect(storedPreferences.selections[preferenceKey]).toEqual({
            kind: 'plugin',
            pluginId: 'plugin.retired',
            contributionLocalId: 'markdown',
        });
        expect(resolveWorkspaceFileViewerChoiceModel({
            metadata: markdownMetadata,
            preferences: storedPreferences,
            availablePluginViewers: [
                candidate({ pluginId: 'plugin.available', viewer: otherwiseMatchingViewer }),
            ],
        }).unavailablePreference).toEqual({
            pluginId: 'plugin.retired',
            contributionLocalId: 'markdown',
        });
        expect(resolveWorkspaceFileViewer({ metadata: markdownMetadata, preferences: storedPreferences,
            availablePluginViewers: [candidate({ pluginId: 'plugin.retired', viewer: otherwiseMatchingViewer })],
        })).toMatchObject({ kind: 'plugin', candidate: { identity: { pluginId: 'plugin.retired', localId: 'markdown' } } });
    });

    it('honors an explicit built-in preference', () => {
        const preferenceKey = serializeOpenableContentPreferenceSelectorV1({ kind: 'class', value: 'text' });
        const pluginViewer = viewer({ id: 'markdown', mimeTypes: ['text/markdown'] });

        expect(resolveWorkspaceFileViewer({
            metadata: markdownMetadata,
            preferences: preferences({ [preferenceKey]: { kind: 'builtin' } }),
            availablePluginViewers: [
                candidate({ pluginId: 'plugin.alpha', viewer: pluginViewer }),
            ],
        })).toEqual({ kind: 'builtin' });
    });

    it('keeps the built-in viewer visible beside every currently matching plugin choice', () => {
        const markdown = viewer({ id: 'markdown', mimeTypes: ['text/markdown'] });
        const extension = viewer({ id: 'extension', extensions: ['.md'] });

        const model = resolveWorkspaceFileViewerChoiceModel({
            metadata: markdownMetadata,
            preferences: preferences({}),
            availablePluginViewers: [
                candidate({ pluginId: 'plugin.beta', viewer: extension }),
                candidate({ pluginId: 'plugin.alpha', viewer: markdown }),
            ],
        });

        expect(model.preferenceSelector).toEqual({ kind: 'mime', value: 'text/markdown' });
        expect(model.choices).toMatchObject([
            { kind: 'builtin' },
            { kind: 'plugin', candidate: { identity: { pluginId: 'plugin.alpha', localId: 'markdown' } } },
            { kind: 'plugin', candidate: { identity: { pluginId: 'plugin.beta', localId: 'extension' } } },
        ]);
    });

    it('offers all eleven matching installed viewers and allows each to be selected with a retained unavailable preference', () => {
        const preferenceKey = serializeOpenableContentPreferenceSelectorV1({ kind: 'mime', value: 'text/markdown' });
        const availablePluginViewers = Array.from({ length: 11 }, (_, index) => candidate({
            pluginId: `plugin.${String(index).padStart(2, '0')}`,
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        }));
        const model = resolveWorkspaceFileViewerChoiceModel({
            metadata: markdownMetadata,
            preferences: preferences({
                [preferenceKey]: {
                    kind: 'plugin',
                    pluginId: 'plugin.retired',
                    contributionLocalId: 'markdown',
                },
            }),
            availablePluginViewers,
        });

        expect(model.choices).toHaveLength(13);
        expect(model.choices.slice(0, 2)).toMatchObject([
            { kind: 'builtin' },
            {
                kind: 'unavailable',
                preference: { pluginId: 'plugin.retired', contributionLocalId: 'markdown' },
            },
        ]);
        expect(model.choices.slice(2)).toMatchObject(availablePluginViewers.map((available) => ({
            kind: 'plugin',
            candidate: { identity: { pluginId: available.entry.pluginId, localId: 'markdown' } },
        })));
        for (const available of availablePluginViewers) {
            const selectedModel = resolveWorkspaceFileViewerChoiceModel({
                metadata: markdownMetadata,
                availablePluginViewers,
                preferences: preferences({
                    [preferenceKey]: {
                        kind: 'plugin',
                        pluginId: available.entry.pluginId,
                        contributionLocalId: 'markdown',
                    },
                }),
            });
            expect(selectedModel.selected).toMatchObject({
                kind: 'plugin',
                candidate: { identity: { pluginId: available.entry.pluginId, localId: 'markdown' } },
            });
            expect(selectedModel.choices.filter((choice) => choice.kind === 'plugin')).toHaveLength(11);
        }
    });

    it('projects a current workspace viewer as a semantic details candidate without host capability data', () => {
        const available = candidate({
            pluginId: 'plugin.workspace-viewer',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        });
        const projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            openableContentViewersById: {
                [available.entry.id]: available.entry,
            },
            surfacePlacementsById: {
                [available.placement.id]: available.placement,
            },
        };

        expect(resolveWorkspaceFileViewerCandidates({
            projection,
            targetKind: 'session',
            platform: 'web',
            formFactor: 'tablet',
        })).toEqual([available]);
    });

    it('derives plugin candidates only from a current, renderable projected details destination', () => {
        const current = candidate({
            pluginId: 'plugin.current',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        });
        const unavailable = candidate({
            pluginId: 'plugin.unavailable',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        });
        const mismatched = candidate({
            pluginId: 'plugin.mismatched',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        });
        const splitOrigin = candidate({
            pluginId: 'plugin.split-origin',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        });
        const incompleteOrigin = candidate({
            pluginId: 'plugin.incomplete-origin',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        });
        const viewerRoleBinding = candidate({
            pluginId: 'plugin.viewer-role-binding',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
        });
        const multipleInstances = candidate({
            pluginId: 'plugin.multiple',
            viewer: viewer({ id: 'markdown', mimeTypes: ['text/markdown'] }),
            instancePolicy: 'multiple',
        });
        const unavailablePlacement = {
            ...unavailable.placement,
            availability: { state: 'disabled', reason: 'disabled', diagnostics: [] },
        } satisfies PluginUiSurfacePlacementProjection;
        const mismatchedEntry = {
            ...mismatched.entry,
            destination: { pluginId: 'plugin.mismatched', localId: 'missing' },
        } satisfies PluginUiOpenableContentViewerProjection;
        const splitOriginEntry = {
            ...splitOrigin.entry,
            hostOrigin: {
                machineId: 'machine-a',
                serverId: 'server-1',
                phase: 'current',
                interactionEnabled: true,
                executionOrigin: {
                    serverIdentityId: 'srv_test',
                    materializationRef: {
                        pluginId: 'plugin.split-origin',
                        machineId: 'machine-a',
                        materializationId: 'install-a',
                    },
                },
            },
        } satisfies PluginUiOpenableContentViewerProjection;
        const splitOriginPlacement = {
            ...splitOrigin.placement,
            hostOrigin: {
                machineId: 'machine-b',
                serverId: 'server-1',
                phase: 'current',
                interactionEnabled: true,
                executionOrigin: {
                    serverIdentityId: 'srv_test',
                    materializationRef: {
                        pluginId: 'plugin.split-origin',
                        machineId: 'machine-b',
                        materializationId: 'install-b',
                    },
                },
            },
        } satisfies PluginUiSurfacePlacementProjection;
        const incompleteOriginEntry = {
            ...incompleteOrigin.entry,
            hostOrigin: {
                machineId: 'machine-a',
                serverId: 'server-1',
                phase: 'current',
                interactionEnabled: true,
            },
        } satisfies PluginUiOpenableContentViewerProjection;
        const incompleteOriginPlacement = {
            ...incompleteOrigin.placement,
            hostOrigin: {
                machineId: 'machine-a',
                serverId: 'server-1',
                phase: 'current',
                interactionEnabled: true,
            },
        } satisfies PluginUiSurfacePlacementProjection;
        const projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            openableContentViewersById: {
                [current.entry.id]: current.entry,
                [unavailable.entry.id]: unavailable.entry,
                [mismatchedEntry.id]: mismatchedEntry,
                [splitOriginEntry.id]: splitOriginEntry,
                [incompleteOriginEntry.id]: incompleteOriginEntry,
                [viewerRoleBinding.entry.id]: viewerRoleBinding.entry,
                [multipleInstances.entry.id]: multipleInstances.entry,
            },
            surfacePlacementsById: {
                [current.placement.id]: current.placement,
                [unavailablePlacement.id]: unavailablePlacement,
                [mismatched.placement.id]: mismatched.placement,
                [splitOriginPlacement.id]: splitOriginPlacement,
                [incompleteOriginPlacement.id]: incompleteOriginPlacement,
                [viewerRoleBinding.placement.id]: viewerRoleBinding.placement,
                [multipleInstances.placement.id]: multipleInstances.placement,
            },
        };

        expect(resolveWorkspaceFileViewerCandidates({
            projection,
            targetKind: 'session',
            platform: 'web',
            formFactor: 'tablet',
        })).toEqual([current, viewerRoleBinding]);
        const phoneRuntime = {
            projection,
            targetKind: 'session' as const,
            platform: 'ios' as const,
            formFactor: 'phone' as const,
        };
        const tabletRuntime = {
            ...phoneRuntime,
            formFactor: 'tablet' as const,
        };
        expect(resolveWorkspaceFileViewerCandidates(phoneRuntime)).toEqual([current, viewerRoleBinding]);
        expect(resolveWorkspaceFileViewerCandidates(tabletRuntime)).toEqual([current, viewerRoleBinding]);
    });
});
