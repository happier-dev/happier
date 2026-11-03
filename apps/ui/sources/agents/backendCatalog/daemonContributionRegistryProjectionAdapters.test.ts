import { describe, expect, it, vi } from 'vitest';

import { DaemonPluginUiComposerSurfaceCatalogEntryV1Schema, PluginProjectionV2Schema, type PluginProjectedSettingsV2, type PluginProjectionV2 } from '@happier-dev/protocol';
import { createProjectedAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/createProjectedAgentLocalAuthPlugin';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import * as strictJsonProjection from '@happier-dev/protocol/json/strictJsonValue';
import { PluginUiSurfaceBindingV1Schema } from '@happier-dev/protocol/plugins/ui';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { createPluginDeclarativeModelFixture } from '@/dev/testkit/fixtures/pluginDeclarativeModelFixture';
import * as projectionNormalizer from '@/sync/domains/plugins/ui/projection';
import * as descriptorProjection from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    publishDaemonMergedProjectionInputs,
    mapV2EditableSettingsGroup,
    resolvePluginProjectionEditableSettingsGroup,
} from './daemonContributionRegistryProjectionAdapters';

describe('daemon contribution registry projection adapters', () => {
    it('publishes composer Action selections for resource-backed translation descriptors', () => {
        const pluginId = 'acme.review';
        const occurrenceId = 'review-current';
        const sourceCustody = { kind: 'development', registeredRootId: 'review-root' } as const;
        const protocol = { id: 'review', version: 1 };
        const contributor = { pluginId, contributionId: 'review', occurrenceId, sourceCustody };
        const row = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
            contribution: { pluginId, localId: 'review' }, occurrenceId, projectionGeneration: 1, role: 'region',
            rendererChain: [{ pluginId, localId: 'renderer' }],
            selectedRenderer: { identity: { pluginId, localId: 'renderer' },
                renderer: { kind: 'declarative', contributionId: 'renderer', model: createPluginDeclarativeModelFixture({
                    pluginId, localId: 'renderer', occurrenceId,
                    document: { version: 1, root: { kind: 'text', text: 'Review' } },
                }) }, availability: { state: 'available', reason: 'available', diagnostics: [] } },
            executionOrigin: { serverIdentityId: 'srv_review', sourceRef: { machineId: 'machine-review', pluginId, sourceCustody } },
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: { target: { pluginId, occurrenceId, sourceCustody },
                points: [{ pointId: 'review', protocols: [{ protocol, contributions: [{ contributor, protocol, surfaces: [],
                    operations: [{ point: { pointId: 'review', protocol }, contributor, role: 'setup',
                        action: { pluginId, localId: 'configure' } }],
                }] }] }] },
        });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Review', enabled: true,
                source: { kind: 'local', locator: '/plugins/review' } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                'translations:acme.review': { id: 'translations:acme.review', pluginId, occurrenceId,
                    contributionKind: 'translations', locales: ['en'], resourceIdsByLocale: { en: 'copy-en' } },
            } } },
        });
        const published = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [row] });
        const selection = [...published.composerSurfaceActionInputSelectionFacts.values()];
        expect(selection).toHaveLength(1);
        expect(selection[0]?.selected).toMatchObject([{ pluginId, plugin: { pluginId }, hasTranslations: true, bundles: null }]);
        expect(published.pluginUiProjection.translationsByPluginId[pluginId]?.resourceIdsByLocale).toEqual({ en: 'copy-en' });
        expect(publishDaemonMergedProjectionInputs({ projection: structuredClone(projection), composerSurfaceCatalog: [row] }, published)).toBe(published);
    });

    it('reuses ready models without deriving again for equivalent newly decoded full replies', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 19 });
        const first = publishDaemonMergedProjectionInputs({ projection });
        const replies = Array.from({ length: 100 }, () => structuredClone(projection));
        const normalize = vi.spyOn(projectionNormalizer, 'normalizePluginUiProjection');
        const parseDescriptors = vi.spyOn(descriptorProjection, 'readConnectedAccountDescriptorProjection');
        try {
            for (const reply of replies) expect(publishDaemonMergedProjectionInputs({ projection: reply }, first)).toBe(first);
            expect(normalize).not.toHaveBeenCalled();
            expect(parseDescriptors).not.toHaveBeenCalled();
        } finally {
            normalize.mockRestore();
            parseDescriptors.mockRestore();
        }
    });

    it('publishes changed translation bundles with canonical immutable ownership for unchanged selected reads', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 20,
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                'translations:acme.review': { id: 'translations:acme.review', pluginId: 'acme.review', occurrenceId: 'review-current',
                    contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Review' } } },
            } } },
        });
        const first = publishDaemonMergedProjectionInputs({ projection });
        const changed = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({
            ...projection, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                ...projection.familiesById.pluginUi?.entriesById,
                'translations:acme.review': { ...projection.familiesById.pluginUi?.entriesById['translations:acme.review'],
                    bundles: { en: { title: 'Changed' } } },
            } } },
        }) }, first);
        const bundles = changed.pluginUiProjection.translationsByPluginId['acme.review']?.bundles;
        expect(bundles).toEqual({ en: { title: 'Changed' } });
        expect(projectNativeJsonValueForTransport(bundles)).toBe(bundles);
    });

    it('projects a 100-plugin catalog only on changed UI arrivals, without requesting ownership of admitted bundles again', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 20,
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries([
                ...Array.from({ length: 100 }, (_, index) => {
                    const pluginId = `acme.arrival-${index}`;
                    return [`translations:${pluginId}`, { id: `translations:${pluginId}`, pluginId,
                        occurrenceId: `occurrence-${index}`, contributionKind: 'translations', locales: ['en'],
                        bundles: { en: { title: `Plugin ${index}`, detail: 'An admitted translation bundle' } } }];
                }),
                ...Array.from({ length: 100 }, (_, index) => {
                    const entry = widgetProjectionEntry({ pluginId: `acme.arrival-${index}`, localId: 'panel', target: 'app' });
                    return [entry.id, entry];
                }),
            ]) } },
        });
        let published = publishDaemonMergedProjectionInputs({ projection });
        const first = published.pluginUiProjection;
        const admittedBundles = new Set(Object.values(first.translationsByPluginId).map(entry => entry.bundles));
        const json = vi.spyOn(strictJsonProjection, 'projectNativeJsonValueForTransport');
        const bindingAdmission = vi.spyOn(PluginUiSurfaceBindingV1Schema, 'safeParse');
        const bundleOwnershipRequests = () => json.mock.calls.filter(([value]) => value !== null && typeof value === 'object' && Object.hasOwn(value, 'en')).length;
        try {
            // Decoded equal replies and unrelated Agent/generation arrivals
            // do not reconstruct the authored UI graph.
            for (let arrival = 1; arrival <= 20; arrival++) {
                const reply = PluginProjectionV2Schema.parse({ ...structuredClone(projection), generation: projection.generation + arrival,
                    agentsById: { review: { id: 'review', title: `Unrelated Agent observation ${arrival}`,
                        identity: { pluginId: 'acme.agent', localId: 'review' },
                        capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
                });
                published = publishDaemonMergedProjectionInputs({ projection: reply }, published);
                expect(published.pluginProjectionV2?.generation).toBe(reply.generation);
                expect(published.pluginUiProjection === first).toBe(true);
                expect(published.pluginUiProjection.translationsByPluginId).toBe(first.translationsByPluginId);
                expect(publishDaemonMergedProjectionInputs({ projection: structuredClone(reply) }, published)).toBe(published);
            }
            expect.soft(json.mock.calls.filter(([value]) => admittedBundles.has(value))).toHaveLength(0);
            expect.soft(bundleOwnershipRequests()).toBe(0);
            expect.soft(bindingAdmission.mock.calls.length).toBe(0);
            json.mockClear(); bindingAdmission.mockClear();

            const edited = PluginProjectionV2Schema.parse({ ...projection, generation: projection.generation + 20,
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                ...projection.familiesById.pluginUi!.entriesById,
                'translations:acme.arrival-0': { ...projection.familiesById.pluginUi!.entriesById['translations:acme.arrival-0'],
                    bundles: { en: { title: 'Edited at the same generation' } } },
            } } } });
            published = publishDaemonMergedProjectionInputs({ projection: edited }, published);
            expect(published.pluginUiProjection.translationsByPluginId['acme.arrival-0']?.bundles)
                .toEqual({ en: { title: 'Edited at the same generation' } });
            expect(published.pluginUiProjection.translationsByPluginId['acme.arrival-99'])
                .toBe(first.translationsByPluginId['acme.arrival-99']);
            expect.soft(json.mock.calls.filter(([value]) => admittedBundles.has(value))).toHaveLength(0);
            expect.soft(bundleOwnershipRequests()).toBe(1);
            expect.soft(bindingAdmission.mock.calls.length).toBe(0);
            json.mockClear(); bindingAdmission.mockClear();

            const changedWidget = widgetProjectionEntry({ pluginId: 'acme.arrival-0', localId: 'panel', target: 'app', title: 'Edited widget' });
            const widgetEdit = PluginProjectionV2Schema.parse({ ...edited, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                ...edited.familiesById.pluginUi!.entriesById, [changedWidget.id]: changedWidget,
            } } } });
            published = publishDaemonMergedProjectionInputs({ projection: widgetEdit }, published);
            expect(published.pluginUiProjection.surfacePlacementsById[changedWidget.id]?.display.title).toBe('Edited widget');
            expect(bindingAdmission.mock.calls.length).toBe(1);
            expect(bundleOwnershipRequests()).toBe(0);

            const withdrawn = PluginProjectionV2Schema.parse({ v: 2, generation: edited.generation });
            published = publishDaemonMergedProjectionInputs({ projection: withdrawn }, published);
            expect(published.pluginUiProjection.translationsByPluginId).toEqual({});
            expect(first.translationsByPluginId['acme.arrival-0']?.bundles)
                .toEqual({ en: { title: 'Plugin 0', detail: 'An admitted translation bundle' } });
        } finally {
            json.mockRestore(); bindingAdmission.mockRestore();
        }
    });

    it('owns immutable adapted rows without freezing or retaining aliases to the raw V2 input', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 19,
            agentsById: { review: { id: 'review', title: 'Review', identity: { pluginId: 'acme.review', localId: 'review' },
                connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'acme.review', localId: 'account' }, credentialKinds: ['oauth'] }],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
            installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true,
                source: { kind: 'local', locator: '/plugins/review' } } },
            actionsById: { 'acme.review/refresh': { id: 'refresh', pluginId: 'acme.review', occurrenceId: 'review-current',
                title: 'Refresh', scopes: ['session'], surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'writesRemote',
                inputHints: { title: 'Refresh', submitLabel: 'Refresh', fields: [{ path: 'reason', title: 'Reason', widget: 'textarea', required: true }] } } },
        });
        const published = publishDaemonMergedProjectionInputs({ projection });
        const purposes = published.mergedProviderProjectionById.review!.connectedAccounts!;
        expect(Object.isFrozen(purposes)).toBe(true);
        expect(Object.isFrozen(purposes[0]!.service)).toBe(true);
        expect(Reflect.set(projection.agentsById.review!.connectedAccounts![0]!, 'purpose', 'changed')).toBe(true);
        expect(purposes[0]!.purpose).toBe('primary');
        const row = published.pluginProjectionById['acme.review']!;
        const hint = projection.actionsById['acme.review/refresh']!.inputHints?.fields?.[0];
        if (!hint) throw new Error('Expected authored form field');
        expect(published.pluginProjectionV2).toBe(projection);
        expect(Reflect.set(projection.installedPackagesById['acme.review']!.source, 'locator', '/plugins/changed')).toBe(true);
        expect(Reflect.set(hint, 'title', 'Changed')).toBe(true);
        expect(row.installedPackage?.source.locator).toBe('/plugins/review');
        expect(row.actions[0]?.localizedPresentation?.inputHints?.fields?.[0]?.title).toBe('Reason');
        expect(Object.isFrozen(row)).toBe(true);
        expect(Object.isFrozen(row.actions)).toBe(true);
        expect(Object.isFrozen(row.actions[0]?.localizedPresentation?.inputHints?.fields?.[0])).toBe(true);
        const changed = publishDaemonMergedProjectionInputs({ projection }, published);
        expect(changed.mergedProviderProjectionById.review!.connectedAccounts![0]!.purpose).toBe('changed');
        expect(changed).not.toBe(published);
        expect(changed.pluginProjectionV2).toBe(projection);
        expect(changed.pluginProjectionById['acme.review']?.installedPackage?.source.locator).toBe('/plugins/changed');
        expect(changed.pluginProjectionById['acme.review']?.actions[0]?.localizedPresentation?.inputHints?.fields?.[0]?.title).toBe('Changed');
        expect(row.installedPackage?.source.locator).toBe('/plugins/review');
    });

    it('keeps same-generation selected replies response-local instead of borrowing omitted full-projection rows', () => {
        const installedPackagesById = { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true,
            source: { kind: 'local', locator: '/plugins/review' } } };
        const full = publishDaemonMergedProjectionInputs({ resourceDeclarations: 'complete', projection: PluginProjectionV2Schema.parse({
            v: 2, generation: 17,
            installedPackagesById,
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                'translations:acme.review': { id: 'translations:acme.review', pluginId: 'acme.review',
                    occurrenceId: 'review-occurrence',
                    contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Review' } } },
            } } },
        }) });
        expect(full.pluginUiProjection.installedPackagesById['acme.review']?.resourceDeclarationsComplete).toBe(true);
        const selectedProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 17, installedPackagesById });
        const selected = publishDaemonMergedProjectionInputs({ projection: selectedProjection }, full);
        expect(selected.pluginProjectionV2).toBe(selectedProjection);
        expect(selected.pluginUiProjection.translationsByPluginId).toEqual({});
        expect(full.pluginUiProjection.translationsByPluginId['acme.review']).toBeDefined();
        expect(selected.pluginUiProjection).not.toBe(full.pluginUiProjection);
        expect(selected.pluginUiProjection.installedPackagesById['acme.review']?.resourceDeclarationsComplete).toBeUndefined();
        // Identical payloads are not evidence that a selected read is a full census.
        const complete = publishDaemonMergedProjectionInputs({ projection: selectedProjection, resourceDeclarations: 'complete' }, selected);
        expect(complete.pluginUiProjection.installedPackagesById['acme.review']?.resourceDeclarationsComplete).toBe(true);
        const partial = publishDaemonMergedProjectionInputs({ projection: selectedProjection }, complete);
        expect(partial.pluginUiProjection.installedPackagesById['acme.review']?.resourceDeclarationsComplete).toBeUndefined();
    });

    it('retains pathless contextual Resources without turning their ids into filenames', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true,
                source: { kind: 'local', locator: '/plugins/review' } } }, resourcesById: {
            'acme.review/live-status': { id: 'live-status', pluginId: 'acme.review', resourceKind: 'config',
                scope: 'session', contentType: 'application/json' },
        } });
        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(adapted.pluginProjectionById['acme.review']?.resources).toEqual([
            { id: 'live-status', resourceKind: 'config', scope: 'session', digest: null, contentType: 'application/json' },
        ]);
        const first = publishDaemonMergedProjectionInputs({ projection, resourceDeclarations: 'complete' });
        const changed = publishDaemonMergedProjectionInputs({ resourceDeclarations: 'complete', projection: PluginProjectionV2Schema.parse({
            ...projection, resourcesById: { 'acme.review/live-status': { ...projection.resourcesById['acme.review/live-status'], contentType: 'text/plain' } },
        }) }, first);
        expect(changed.pluginUiProjection.resourcesById['acme.review/live-status']?.contentType).toBe('text/plain');
        expect(changed.pluginUiProjection.installedPackagesById['acme.review']?.resourceDeclarationsComplete).toBe(true);
        expect(first.pluginUiProjection.resourcesById['acme.review/live-status']?.contentType).toBe('application/json');
        const withdrawn = publishDaemonMergedProjectionInputs({ resourceDeclarations: 'complete', projection: PluginProjectionV2Schema.parse({
            ...projection, resourcesById: {},
        }) }, changed);
        expect(withdrawn.pluginUiProjection.resourcesById).toEqual({});
        expect(withdrawn.pluginUiProjection.installedPackagesById['acme.review']?.resourceDeclarationsComplete).toBe(true);
        expect(projectionNormalizer.readCompletePluginUiResourceDeclarations(withdrawn.pluginUiProjection, 'acme.review', undefined)).toEqual({});
    });
    it('resolves every localized Settings label through the shared plugin text owner', () => {
        const settings: PluginProjectedSettingsV2 = {
            id: 'acme.review.settings',
            pluginId: 'acme.review',
            version: 1,
            title: { key: 'settings.title', fallback: 'Review settings' },
            description: { key: 'settings.description', fallback: 'Configure review' },
            scope: { kind: 'account' },
            presentation: { sections: [], subagentSections: [] },
            target: { kind: 'plugin' },
            fields: [{
                id: 'enabled',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'boolean' },
                valueType: 'boolean',
                control: 'switch',
                secretCustody: null,
                displayKey: { key: 'settings.enabled', fallback: 'Enabled' },
                descriptionKey: { key: 'settings.enabled.description', fallback: 'Use review' },
                redaction: 'none',
                clearWhenEmpty: 'persist',
                capabilityGates: [],
                permissionGates: [],
            }],
        };
        const seen: unknown[] = [];

        const resolved = resolvePluginProjectionEditableSettingsGroup(
            mapV2EditableSettingsGroup(settings),
            (pluginId, value) => {
                seen.push([pluginId, value]);
                return typeof value === 'string' ? value : `localized:${value.key}`;
            },
        );

        expect(resolved).toMatchObject({
            title: 'localized:settings.title',
            description: 'localized:settings.description',
            fields: [{
                title: 'localized:settings.enabled',
                subtitle: 'localized:settings.enabled.description',
            }],
        });
        expect(seen).toHaveLength(4);
    });

    it('preserves projected secret custody for the Settings presentation dispatcher', () => {
        const settings: PluginProjectedSettingsV2 = {
            id: 'acme.review.settings',
            pluginId: 'acme.review',
            version: 1,
            title: 'Review settings',
            scope: { kind: 'account' },
            presentation: { sections: [], subagentSections: [] },
            target: { kind: 'plugin' },
            fields: [{
                id: 'machine-only-token',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                valueType: 'string',
                control: 'password',
                secretCustody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'serverBaseUrl' },
                displayKey: 'Machine-only token',
                redaction: 'secret',
                clearWhenEmpty: 'omit',
                capabilityGates: [],
                permissionGates: [],
            }],
        };

        expect(mapV2EditableSettingsGroup(settings).fields).toEqual([
            expect.objectContaining({
                key: 'machine-only-token',
                secretCustody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'serverBaseUrl' },
            }),
        ]);
    });

    it('adapts plugin projection v2 registry metadata', () => {
        const authorization: NonNullable<
            PluginProjectionV2['actionsById'][string]['authorization']
        > = {
            generation: {
                targetGeneration: 'generation-42',
                desiredGeneration: 'generation-42',
                appliedGeneration: 'generation-42',
                targetGenerationMode: 'current',
            },
            resourceSelections: [],
            scopedGrants: [],
            serviceAvailability: [],
            operatingSystemAuthorization: [],
        };
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 42,
            installedPackagesById: {
                'acme.review': {
                    id: 'acme.review',
                    displayName: 'Acme Review',
                    version: '1.2.3',
                    enabled: true,
                    immutableGenerationId: 'generation-42',
                    occurrenceId: 'acme-review-occurrence-42',
                    source: {
                        kind: 'localPath',
                        locator: '/plugins/acme-review',
                    },
                    brand: {
                        state: 'available',
                        resource: { pluginId: 'acme.review', localId: 'brand' },
                        width: 128,
                        height: 128,
                        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                },
            },
            agentsById: {
                'acme.native': {
                    id: 'acme.native',
                    identity: {
                        pluginId: 'acme.review',
                        localId: 'acme-native',
                    },
                    iconAgentId: 'claude',
                    channel: 'plugin',
                    isBuiltIn: false,
                    connectedAccounts: [{
                        purpose: 'primary',
                        service: { pluginId: 'acme.review', localId: 'account' },
                        required: false,
                    }],
                    providerOwnedEnvironmentKeys: [],
                    cli: {
                        executable: { binaryName: 'acme', sourcePreference: 'system-first' },
                        install: { manual: { kind: 'none' } },
                        auth: {
                            support: 'login_terminal',
                            loginLaunches: [
                                { kind: 'primary', args: ['login'] },
                                { kind: 'device_code', args: ['login', '--device-code'] },
                            ],
                        },
                    },
                },
            },
            actionsById: {
                'acme.review.refresh': {
                    id: 'acme.review.refresh',
                    pluginId: 'acme.review',
                    occurrenceId: 'acme-review-occurrence-42',
                    title: 'Refresh Acme',
                    description: 'Refresh Acme resources',
                    scopes: ['settings'],
                    surfaces: ['agent'],
                    execution: { target: 'daemon' },
                    placementBindings: ['detailsPanel'],
                    inputHints: {
                        title: 'Refresh Acme',
                        submitLabel: 'Refresh',
                        fields: [{
                            path: 'reason',
                            title: 'Reason',
                            widget: 'textarea',
                            required: true,
                        }],
                    },
                    dangerLevel: 'writesRemote',
                    confirmation: {
                        title: { key: 'actions.refresh.title', fallback: 'Refresh remote resources?' },
                        body: { key: 'actions.refresh.body', fallback: 'This changes remote resources.' },
                        confirmLabel: { key: 'actions.refresh.confirm', fallback: 'Refresh' },
                    },
                    authorization,
                    available: true,
                },
                'acme.review.refresh-provider-state': {
                    id: 'acme.review.refresh-provider-state',
                    pluginId: 'acme.review',
                    occurrenceId: 'acme-review-occurrence-42',
                    title: 'Refresh provider state',
                    scopes: ['session'],
                    surfaces: ['plugin'],
                    execution: { target: 'daemon' },
                    dangerLevel: 'writesRemote',
                },
            },
            familiesById: {},


            resourcesById: {
                'acme.review.prompt': {
                    id: 'acme.review.prompt',
                    pluginId: 'acme.review',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                    digest: 'sha256:prompt',
                    contentType: 'text/markdown',
                },
                'acme.review/live-status': {
                    id: 'live-status', pluginId: 'acme.review', resourceKind: 'config',
                    scope: 'session', contentType: 'application/json',
                },
            },
            settingsById: {
                'acme.review.settings': {
                    id: 'settings',
                    pluginId: 'acme.review',
                    version: 1,
                    title: 'Review settings',
                    scope: { kind: 'daemon' },
                    presentation: { sections: [], subagentSections: [] },
                    target: { kind: 'plugin' },
                    fields: [],
                },
            },
            diagnostics: [
                {
                    version: 1,
                    id: 'acme.review:normalization:plugin:0',
                    data: {
                        severity: 'warning',
                        code: 'registry.warning',
                        message: 'Registry rebuilt with warnings',
                    },
                    plugin: { id: 'acme.review', version: '1.2.3', source: 'localPath' },
                    stage: 'normalization',
                    occurrenceId: '42',
                    host: 'daemon',
                    platform: 'darwin',
                    occurredAtMs: 1,
                    resolution: { state: 'current' },
                },
                {
                    version: 1,
                    id: 'acme.review:activation:plugin:0',
                    data: {
                        severity: 'info',
                        code: 'plugin.activated',
                        message: 'Activation completed',
                    },
                    plugin: { id: 'acme.review', version: '1.2.3', source: 'localPath' },
                    stage: 'activation',
                    occurrenceId: '42',
                    host: 'daemon',
                    platform: 'darwin',
                    occurredAtMs: 2,
                    resolution: { state: 'current' },
                },
            ],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(adapted.mergedProviderProjectionById['acme.native']?.identity).toEqual({
            pluginId: 'acme.review',
            localId: 'acme-native',
        });
        expect(adapted.mergedProviderProjectionById['acme.native']).toEqual(expect.objectContaining({
            qualifiedId: 'acme.native',
            projectionGeneration: 42,
            installedPackage: expect.objectContaining({
                id: 'acme.review',
                immutableGenerationId: 'generation-42',
                brand: expect.objectContaining({ state: 'available' }),
            }),
        }));

        expect(adapted.mergedProviderProjectionById['acme.native']?.cli?.auth.loginLaunches).toEqual([
            { kind: 'primary', args: ['login'] },
            { kind: 'device_code', args: ['login', '--device-code'] },
        ]);
        expect(adapted.mergedProviderProjectionById['acme.native']?.connectedAccounts).toEqual([{
            purpose: 'primary',
            service: { pluginId: 'acme.review', localId: 'account' },
            required: false,
        }]);
        const projectedCli = adapted.mergedProviderProjectionById['acme.native']?.cli;
        if (!projectedCli) throw new Error('expected native Agent CLI/auth projection');
        const authPlugin = createProjectedAgentLocalAuthPlugin({
            agentId: 'acme.native',
            cli: projectedCli,
        });
        expect(authPlugin.loginLaunchKinds).toEqual(['primary', 'device_code']);
        expect(authPlugin.buildLoginLaunch?.({
            kind: 'device_code',
            resolvedCommand: "'/opt/runtime/bun' '/opt/acme/acme.js'",
        })).toEqual({
            launch: { kind: 'agent_login', agentId: 'acme.native', launchId: 'device_code' },
        });

        // The plugin shows the mark of the Agent it contributes, rather than a letter.
        expect(adapted.pluginProjectionById?.['acme.review']?.iconAgentId).toBe('claude');
        expect(adapted.pluginProjectionById?.['acme.review']).toEqual(expect.objectContaining({
            pluginId: 'acme.review',
            occurrenceId: 'acme-review-occurrence-42',
            title: 'Acme Review',
            version: '1.2.3',
            enabled: true,
            generation: 42,
            generationLabel: '42',
            provenance: expect.objectContaining({
                sourceKind: 'localPath',
                sourceLabel: '/plugins/acme-review',
            }),
            diagnostics: [
                { code: 'registry.warning', message: 'Registry rebuilt with warnings', severity: 'warning' },
                { code: 'plugin.activated', message: 'Activation completed', severity: 'info' },
            ],
            actions: [
                expect.objectContaining({
                    id: 'acme.review.refresh',
                    title: 'Refresh Acme',
                    inputHints: {
                        title: 'Refresh Acme',
                        submitLabel: 'Refresh',
                        fields: [{
                            path: 'reason',
                            title: 'Reason',
                            widget: 'textarea',
                            required: true,
                        }],
                    },
                    dangerLevel: 'writesRemote',
                    confirmation: {
                        title: { key: 'actions.refresh.title', fallback: 'Refresh remote resources?' },
                        body: { key: 'actions.refresh.body', fallback: 'This changes remote resources.' },
                        confirmLabel: { key: 'actions.refresh.confirm', fallback: 'Refresh' },
                    },
                    authorization,
                }),
                expect.objectContaining({
                    id: 'acme.review.refresh-provider-state',
                    placementBindings: [],
                }),
            ],
            resources: [
                expect.objectContaining({
                    id: 'acme.review.prompt',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                }),
                expect.objectContaining({ id: 'live-status', resourceKind: 'config', scope: 'session' }),
            ],
            editableSettingsGroups: [
                expect.objectContaining({
                    id: 'settings',
                    scope: { kind: 'daemon' },
                }),
            ],
        }));
        expect(adapted.registryDiagnostics).toEqual([]);
        // Action schemas are read lazily through the daemon action-schema endpoint.
        expect(adapted.pluginProjectionById['acme.review']?.actions.find(action => action.id === 'acme.review.refresh-provider-state')).not.toHaveProperty('inputSchema');
        expect(adapted.pluginProjectionById['acme.review']?.resources.find(resource => resource.id === 'live-status')).not.toHaveProperty('path');
    });

    it('gives a bundled Agent plugin the mark of the Agent it is, as the Agent picker does', () => {
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 7,
            installedPackagesById: {
                'happier.claude': {
                    id: 'happier.claude',
                    displayName: 'Claude',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.claude' },
                },
                'acme.fork': {
                    id: 'acme.fork',
                    displayName: 'Fork',
                    version: '1.0.0',
                    enabled: true,
                    source: { kind: 'npm', locator: 'acme-fork' },
                },
            },
            agentsById: {
                // A bundled Agent names no separate icon: it is the Claude Agent.
                claude: {
                    id: 'claude',
                    identity: { pluginId: 'happier.claude', localId: 'claude' },
                    channel: 'stable',
                    isBuiltIn: true,
                    providerOwnedEnvironmentKeys: [],
                },
                // An Agent that names its icon wears that icon, ahead of the catalog Agent it runs as.
                'acme.fork/fork': {
                    id: 'acme.fork/fork',
                    identity: { pluginId: 'acme.fork', localId: 'fork' },
                    channel: 'stable',
                    isBuiltIn: false,
                    iconAgentId: 'claude',
                    catalogAgentId: 'codex',
                    providerOwnedEnvironmentKeys: [],
                },
            } as unknown as PluginProjectionV2['agentsById'],
            actionsById: {},
            familiesById: {},


            resourcesById: {},
            settingsById: {},
            diagnostics: [],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        expect(adapted.pluginProjectionById['happier.claude']?.iconAgentId).toBe('claude');
        expect(adapted.pluginProjectionById['acme.fork']?.iconAgentId).toBe('claude');
    });

    it('says what kinds of things each plugin contributes, from its Agents and contribution families', () => {
        const pkg = (id: string) => ({ id, displayName: id, version: '1.0.0', enabled: true, source: { kind: 'bundled', locator: id } });
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 1,
            installedPackagesById: {
                'happier.claude': pkg('happier.claude'),
                'happier.github': pkg('happier.github'),
                'happier.elevenlabs': pkg('happier.elevenlabs'),
                'happier.empty': pkg('happier.empty'),
            },
            agentsById: {
                claude: { id: 'claude', identity: { pluginId: 'happier.claude', localId: 'claude' }, channel: 'stable', isBuiltIn: true, providerOwnedEnvironmentKeys: [] },
            } as unknown as PluginProjectionV2['agentsById'],
            actionsById: {},
            familiesById: {
                scmHostingProviders: { family: 'scmHostingProviders', entriesById: { github: { id: 'github', pluginId: 'happier.github' } } },
                voiceProviders: { family: 'voiceProviders', entriesById: { el: { id: 'el', pluginId: 'happier.elevenlabs' } } },
                providers: { family: 'providers', entriesById: { claudeModels: { id: 'claudeModels', pluginId: 'happier.claude' } } },
            } as unknown as PluginProjectionV2['familiesById'],


            resourcesById: {},
            settingsById: {},
            diagnostics: [],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        // An Agent comes first: it is what the plugin is for.
        expect(adapted.pluginProjectionById['happier.claude']?.contributionKinds).toEqual(['agent', 'providers']);
        expect(adapted.pluginProjectionById['happier.github']?.contributionKinds).toEqual(['scmHostingProviders']);
        expect(adapted.pluginProjectionById['happier.elevenlabs']?.contributionKinds).toEqual(['voiceProviders']);
        expect(adapted.pluginProjectionById['happier.empty']?.contributionKinds).toEqual([]);
    });

    it('keeps a target semantic diagnostic on the target Settings entry', () => {
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 42,
            installedPackagesById: {
                'happier.channels': {
                    id: 'happier.channels',
                    displayName: 'Channels',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.channels' },
                },
                'happier.channel.telegram': {
                    id: 'happier.channel.telegram',
                    displayName: 'Telegram',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.channel.telegram' },
                },
                'happier.scm.forge.github': {
                    id: 'happier.scm.forge.github',
                    displayName: 'GitHub',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.scm.forge.github' },
                },
            },
            agentsById: {},
            actionsById: {},
            familiesById: {},


            resourcesById: {},
            settingsById: {},
            diagnostics: [{
                version: 1,
                id: 'happier.channels:runtime:happier.channels/providers:0',
                data: {
                    severity: 'error',
                    code: 'target_semantics_unavailable',
                    message: 'Targeted contribution semantics rejected (target_semantics_unavailable).',
                    details: {
                        target: { pluginId: 'happier.channels', pointId: 'providers' },
                        contributor: { pluginId: 'happier.channel.telegram', contributionId: 'telegram' },
                        protocol: { id: 'happier.channels/providers', version: 1 },
                        reason: 'target_semantics_unavailable',
                    },
                },
                plugin: { id: 'happier.channels', version: '0.0.0', source: 'bundled' },
                contribution: { pluginId: 'happier.channels', localId: 'providers' },
                stage: 'runtime',
                occurrenceId: 'channels-occurrence-a',
                host: 'daemon',
                platform: 'test',
                occurredAtMs: 1,
                resolution: { state: 'current' },
            }],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        expect(adapted.pluginProjectionById['happier.channels']?.diagnostics).toEqual([{
            code: 'target_semantics_unavailable',
            message: 'Targeted contribution semantics rejected (target_semantics_unavailable).',
            severity: 'error',
            details: {
                target: { pluginId: 'happier.channels', pointId: 'providers' },
                contributor: { pluginId: 'happier.channel.telegram', contributionId: 'telegram' },
                protocol: { id: 'happier.channels/providers', version: 1 },
                reason: 'target_semantics_unavailable',
            },
            contribution: { pluginId: 'happier.channels', localId: 'providers' },
        }]);
        expect(adapted.pluginProjectionById['happier.channel.telegram']?.diagnostics).toEqual([]);
        expect(adapted.pluginProjectionById['happier.scm.forge.github']?.diagnostics).toEqual([]);
    });

});
