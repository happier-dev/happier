import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import {
    PluginAvailabilityActionHttpPathsV1,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/mocks/machineAdministrationTargetSelection';
import {
    createActivePluginAccountAvailabilityProjectionHydrator,
} from '@/sync/api/plugins/availability/pluginAvailabilityProjection';
import {
    createPluginAccountAvailabilityReader,
    type PluginAccountAvailabilityReader,
} from '@/sync/domains/plugins/availability/reader';

import type { InstalledPluginEntry } from './model/pluginMarketplaceModel';
import { PluginDetailLeaveActions } from './detail/PluginDetailLeaveActions';

type GenericSettingsSectionProps = React.ComponentProps<
    typeof import('./detail/PluginDetailGenericSettingsSection').PluginDetailGenericSettingsSection
>;

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

// The real erase recovery section is the outermost instance carrying its
// testID, so this reads the plugin id the screen hands the section.
function eraseEntry(screen: RenderedScreen, testID: string) {
    return screen.findAllByTestId(testID)[0] ?? null;
}

// A plugin page ends with its leave actions; the erase control there is bound
// to the plugin id those actions receive (usePluginAccountDataErase(pluginId)).
function detailEraseOwner(screen: RenderedScreen) {
    expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.accountDataErase')).not.toBeNull();
    return screen.findAllByType(PluginDetailLeaveActions)[0] ?? null;
}

const state = vi.hoisted<{ value: Record<string, unknown> }>(() => ({ value: {} }));
const genericSettingsProps = vi.hoisted(() => vi.fn());
const accountAvailability = vi.hoisted<{ reader: PluginAccountAvailabilityReader | null }>(() => ({ reader: null }));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        ScrollView: 'ScrollView',
        View: 'View',
    });
});

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/ui/lists/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: React.PropsWithChildren) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({ SegmentedTabBar: 'SegmentedTabBar' }));
vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({ MachineAdministrationTargetSelector: 'MachineAdministrationTargetSelector' }));
vi.mock('@/components/settings/machines/PluginMachineExecutionOriginSelector', () => ({
    PluginMachineExecutionOriginSelectorView: 'PluginMachineExecutionOriginSelectorView',
    resolvePluginMachineExecutionOriginPresentation: () => ({
        title: 'newSession.noMachineSelected',
        detail: 'common.unavailable',
        selected: false,
    }),
}));
vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReader: () => accountAvailability.reader,
    useActivePluginAccountAvailabilityReleaseClassifier: () => () => ({
        releaseContent: 'unknown',
        validation: { kind: 'rejected', reason: 'unknown' },
    }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));
vi.mock('@/components/settings/catalog/routes', () => ({ SETTINGS_ROUTES: { pluginWebhooks: '/settings/plugins/webhooks' } }));
vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn(), confirm: vi.fn(), alertAsync: vi.fn() } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('./PluginMarketplaceSections', () => ({
    CatalogEntriesSection: 'CatalogEntriesSection',
    DevelopmentPluginsSection: 'DevelopmentPluginsSection',
    InstalledPluginsSection: 'InstalledPluginsSection',
    PendingPluginChangesSection: 'PendingPluginChangesSection',
    PluginRoutineOperationSettlementRow: 'PluginRoutineOperationSettlementRow',
    PluginDiagnosticsSnapshotSection: 'PluginDiagnosticsSnapshotSection',
}));
vi.mock('./model/usePluginSettingsScreenState', () => ({ usePluginSettingsScreenState: () => state.value }));
vi.mock('./NpmRegistryProfilesSection', () => ({ NpmRegistryProfilesSection: 'NpmRegistryProfilesSection' }));
vi.mock('./NativeAppPluginPanelsSettingsEntry', () => ({ NativeAppPluginPanelsSettingsEntry: 'NativeAppPluginPanelsSettingsEntry' }));
vi.mock('./PluginAppPagesSettingsEntry', () => ({ PluginAppPagesSettingsEntry: 'PluginAppPagesSettingsEntry' }));

vi.mock('./detail/PluginDetailActionsSection', () => ({ PluginDetailActionsSection: 'PluginDetailActionsSection' }));
vi.mock('./detail/PluginDetailContributionsSection', () => ({ PluginDetailContributionsSection: 'PluginDetailContributionsSection' }));
vi.mock('./detail/PluginDetailDiagnosticsSection', () => ({ PluginDetailDiagnosticsSection: 'PluginDetailDiagnosticsSection' }));
vi.mock('./detail/PluginDetailGenericSettingsSection', () => ({
    PluginDetailGenericSettingsSection: (props: GenericSettingsSectionProps) => {
        genericSettingsProps(props);
        return null;
    },
}));
vi.mock('./detail/PluginDetailSummaryGrid', () => ({ PluginDetailSummaryGrid: 'PluginDetailSummaryGrid' }));

function createState() {
    return {
        activeView: 'installed',
        administrationTargetSelection: createMachineAdministrationTargetSelectionFixture({
            machines: [],
            selectedMachineId: null,
        }),
        accountServerIdentityId: null,
        selectedServerIdentityId: null,
        executionServerIdentityId: null,
        executionServerId: null,
        executionMachineId: null,
        readOnlySnapshotNotice: null,
        installedPlugins: [],
        installedPluginById: new Map([['example.installed-plugin', {
            pluginId: 'example.installed-plugin',
            title: 'Installed plugin',
            description: null,
            version: '1.0.0',
            enabled: true,
            source: { kind: 'npm', locator: 'example-installed-plugin' },
            install: { mode: 'managed', manifestVersion: '2' },
            compatibility: { status: 'compatible', diagnostics: [] },
            diagnostics: [],
        } satisfies InstalledPluginEntry]]),
        discoverSources: [],
        selectedDiscoverSourceId: null,
        discoverSearchText: '',
        pluginProjectionById: {},
        registryDiagnostics: [],
        isPluginActionInFlight: () => false,
        canRefreshInstalledPlugins: false,
        // The selected daemon has answered; a cold deep link that has not yet
        // settled stays on its loading pane instead (accountHosting suite).
        pluginTruthSettled: true,
        daemonOperationsAvailable: false,
        refreshPluginTruth: vi.fn(),
        developmentCreateAvailable: false,
        developmentSourceInstallAvailable: false,
        developmentPlugins: [],
        marketplaceSourceRegistry: null,
        runCatalogAction: vi.fn(),
        runDevelopmentCreate: vi.fn(),
        runDevelopmentSourceInstall: vi.fn(),
        runDevelopmentAction: vi.fn(),
        runInstalledPluginAction: vi.fn(),
        setActiveView: vi.fn(),
        setCatalogUrl: vi.fn(),
        setMarketplaceSourceProfile: vi.fn(),
        currentDiagnostics: [],
    };
}

const EXAMPLE_MATERIALIZATION = {
    serverIdentityId: 'server-identity-1',
    machineId: 'machine-1',
    materializationId: 'materialization-1',
    pluginId: 'example.installed-plugin',
    version: '1.0.0',
    sourceClass: 'versionedArchive',
    portableRelease: true,
    uiArtifacts: [],
    enabled: true,
    trustState: 'trusted',
    observedAt: 1,
} satisfies PluginMachineMaterializationV1;

const ACCOUNT_SCOPE = {
    serverId: 'server-account-recovery',
    accountId: 'account-recovery',
} as const;

function createAccountSettingsDeclaration() {
    return PluginManifestV2Schema.parse({
        schemaVersion: 2,
        id: 'example.installed-plugin',
        version: '1.0.0',
        displayName: 'Installed plugin',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        contributes: {
            settings: [{
                id: 'account-settings',
                version: 1,
                title: 'Account settings',
                scope: 'account',
                target: { kind: 'plugin' },
                presentation: { sections: [], subagentSections: [] },
                fields: [{
                    id: 'apiToken',
                    title: 'API token',
                    schema: { type: 'string' },
                    secret: true,
                }],
            }],
        },
    });
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function hydrateAccountRecoveryReaderAfterReset(
    declaration: ReturnType<typeof PluginManifestV2Schema.parse>,
): Promise<PluginAccountAvailabilityReader> {
    const pluginId = declaration.id;
    const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
        captureLifetime: () => ({
            scope: ACCOUNT_SCOPE,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => {} }),
        }),
        getServerSnapshot: () => ({ serverId: ACCOUNT_SCOPE.serverId, generation: 1 }),
        captureRequestAuthority: async () => ({
            request: async (path, init) => {
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                    return jsonResponse({ availabilityCursor: 42, snapshots: [] });
                }
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                    return jsonResponse({ availabilityCursor: 42, pluginIds: [pluginId] });
                }
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
                    const input = JSON.parse(String(init?.body ?? '{}')) as { pluginId?: string };
                    if (input.pluginId !== pluginId) {
                        throw new Error(`Unexpected Availability intent id: ${String(input.pluginId)}`);
                    }
                    return jsonResponse({
                        availabilityCursor: 42,
                        packageAssets: [],
                        hostingCapability: { enabled: false },
                        intent: {
                            pluginId,
                            desiredVersion: declaration.version,
                            enabled: true,
                            offlineUiHosting: 'disabled',
                            writableCollections: [],
                            revision: '1',
                        },
                        release: {
                            ref: { pluginId, version: declaration.version },
                            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                            normalizedManifest: declaration,
                            collectionContracts: [],
                            uiSlots: [],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [],
                    });
                }
                throw new Error(`Unexpected Availability path: ${path}`);
            },
        }),
    });

    expect(hydrator.invalidate([{
        cursor: 42,
        kind: 'pluginDomain',
        entityId: `pluginDomain/${pluginId}/availability`,
        changedAt: 42,
        hint: { pluginDomain: 'availability', pluginId },
    }])).toEqual([pluginId]);
    await hydrator.refresh();
    hydrator.reset();
    const afterReset = await hydrator.refresh();
    if (!afterReset) {
        throw new Error('Expected the active Account Availability hydration to remain current.');
    }
    return createPluginAccountAvailabilityReader({
        scope: ACCOUNT_SCOPE,
        snapshot: afterReset.snapshot,
    });
}

function createAccountAvailabilityReader(input: Pick<
    PluginAccountAvailabilityReader,
    'readMaterializations' | 'readCurrentSettingsDeclaration'
>): PluginAccountAvailabilityReader {
    return {
        ...input,
        readCurrentArtifact: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentHostedPublicationTarget: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentHostedPackageAssetPublicationTarget: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentHostedArtifactAdministration: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentPackageAsset: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentCollectionContract: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentAccountDataCapability: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentAccountKvCapability: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        readCurrentReleaseSelection: () => ({
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        }),
        classifyRelease: (materialization) => ({
            serverIdentityId: materialization.serverIdentityId,
            materializationRef: {
                machineId: materialization.machineId,
                materializationId: materialization.materializationId,
                pluginId: materialization.pluginId,
            },
            releaseContent: 'unknown',
            validation: { kind: 'rejected', reason: 'unknown' },
        }),
        subscribe: () => () => {},
    };
}

beforeEach(() => {
    state.value = createState();
    accountAvailability.reader = null;
    genericSettingsProps.mockClear();
    machineRpcWithServerScopeMock.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('Account plugin data erase Settings entries', () => {
    it('keeps the orphaned-ID recovery entry reachable from the plugin Diagnostics page', async () => {
        // The configuration-surfaces redesign moved the orphaned-id erase off
        // the Plugins home onto Diagnostics, where the id is already in view.
        const { PluginDiagnosticsScreen } = await import('./diagnostics/PluginDiagnosticsScreen');
        const screen = await renderScreen(<PluginDiagnosticsScreen />);

        const entry = eraseEntry(screen, 'settings.plugins.accountDataErase');
        expect(entry).not.toBeNull();
        expect(entry?.props.pluginId).toBeUndefined();
    });

    it('presents the installed-plugin recovery entry with its canonical plugin id', async () => {
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(detailEraseOwner(screen)?.props.pluginId)
            .toBe('example.installed-plugin');
    });

    it('renders Account Settings recovery after reset when an Account declaration has no activation materialization', async () => {
        const accountSettingsDeclaration = createAccountSettingsDeclaration();
        state.value = {
            ...createState(),
            installedPluginById: new Map(),
        };
        accountAvailability.reader = await hydrateAccountRecoveryReaderAfterReset(accountSettingsDeclaration);
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(detailEraseOwner(screen)?.props.pluginId)
            .toBe('example.installed-plugin');
        const recoveryHeader = screen.findByTestId('settings.plugins.detail.example.installed-plugin.recoveryHeader');
        expect(recoveryHeader).not.toBeNull();
        // The recovery header is the shared entity PageHeader now; it owns the
        // title's presentation (no bespoke two-line clamp), and the plugin name
        // stays the page's accessible header.
        expect(recoveryHeader?.findAll((node) => (node.type as unknown) === 'Text').find((node) => (
            node.props.children === 'Installed plugin'
        ))?.props).toMatchObject({
            accessibilityRole: 'header',
        });
        const recoveryNotice = screen.findHostByTestId('settings.plugins.detail.example.installed-plugin.accountRecovery');
        expect(recoveryNotice?.props.accessibilityLiveRegion).toBe('polite');
        expect(recoveryNotice?.findAll((node) => (node.type as unknown) === 'Text')
            .some((node) => node.props.children === 'settingsPlugins.readOnlyAccountRecovery')).toBe(true);
        expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.accountRecovery-retry')).toBeNull();
        expect(genericSettingsProps).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'example.installed-plugin',
            projection: null,
            machineId: null,
            serverId: null,
            daemonOperationsAvailable: false,
            accountSettingsDeclaration,
        }));
        expect(screen.findAllByType('PluginMachineExecutionOriginSelectorView')).toHaveLength(0);
    });

    it('renders current Account Settings for an installed plugin without a daemon projection', async () => {
        const accountSettingsDeclaration = createAccountSettingsDeclaration();
        accountAvailability.reader = createAccountAvailabilityReader({
            readMaterializations: () => ({
                kind: 'available',
                availabilityCursor: 42,
                intentReads: [],
                materializations: [{ ...EXAMPLE_MATERIALIZATION, enabled: false }],
                snapshots: [],
            }),
            readCurrentSettingsDeclaration: () => ({
                kind: 'available',
                availabilityCursor: 42,
                declaration: accountSettingsDeclaration,
            }),
        });
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(genericSettingsProps).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'example.installed-plugin',
            projection: null,
            accountSettingsDeclaration,
        }));
    });

    it('keeps a current daemon projection authoritative over the Account recovery declaration', async () => {
        const daemonProjection = {
            title: 'Daemon projection',
            description: null,
            status: null,
            editableSettingsGroups: [],
        };
        const readCurrentSettingsDeclaration = vi.fn(() => ({
            kind: 'available' as const,
            availabilityCursor: 42,
            declaration: createAccountSettingsDeclaration(),
        }));
        state.value = {
            ...createState(),
            pluginProjectionById: { 'example.installed-plugin': daemonProjection },
        };
        accountAvailability.reader = createAccountAvailabilityReader({
            readMaterializations: () => ({
                kind: 'available',
                availabilityCursor: 42,
                intentReads: [],
                materializations: [{ ...EXAMPLE_MATERIALIZATION, enabled: false }],
                snapshots: [],
            }),
            readCurrentSettingsDeclaration,
        });
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');

        await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(readCurrentSettingsDeclaration).not.toHaveBeenCalled();
        expect(genericSettingsProps).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'example.installed-plugin',
            projection: daemonProjection,
            accountSettingsDeclaration: null,
        }));
    });

    it('keeps a current daemon projection authoritative when installed metadata is absent', async () => {
        const daemonProjection = {
            title: 'Daemon projection',
            description: null,
            status: null,
            editableSettingsGroups: [],
        };
        const readCurrentSettingsDeclaration = vi.fn(() => ({
            kind: 'available' as const,
            availabilityCursor: 42,
            declaration: createAccountSettingsDeclaration(),
        }));
        state.value = {
            ...createState(),
            installedPluginById: new Map(),
            pluginProjectionById: { 'example.installed-plugin': daemonProjection },
        };
        accountAvailability.reader = createAccountAvailabilityReader({
            readMaterializations: () => ({
                kind: 'available',
                availabilityCursor: 42,
                intentReads: [],
                materializations: [EXAMPLE_MATERIALIZATION],
                snapshots: [],
            }),
            readCurrentSettingsDeclaration,
        });
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.recoveryHeader')).toBeNull();
        expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.accountRecovery')).toBeNull();
        expect(screen.findAllByType('PluginMachineExecutionOriginSelectorView')).toHaveLength(1);
        expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.invocationLogs.target')).not.toBeNull();
        expect(readCurrentSettingsDeclaration).not.toHaveBeenCalled();
        expect(genericSettingsProps).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'example.installed-plugin',
            projection: daemonProjection,
            accountSettingsDeclaration: null,
        }));
    });

    it('retains erase-only recovery for a materialized plugin whose current declaration is unavailable', async () => {
        state.value = {
            ...createState(),
            installedPluginById: new Map(),
        };
        accountAvailability.reader = createAccountAvailabilityReader({
            readMaterializations: () => ({
                kind: 'available',
                availabilityCursor: 42,
                intentReads: [],
                materializations: [EXAMPLE_MATERIALIZATION],
                snapshots: [],
            }),
            readCurrentSettingsDeclaration: () => ({
                kind: 'unavailable',
                code: 'artifact_not_current',
            }),
        });
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(detailEraseOwner(screen)?.props.pluginId)
            .toBe('example.installed-plugin');
        expect(genericSettingsProps).not.toHaveBeenCalled();
    });

    it('keeps an Account-retained cold/offline plugin log surface explicitly unavailable without a machine RPC', async () => {
        state.value = {
            ...createState(),
            installedPluginById: new Map(),
        };
        accountAvailability.reader = createAccountAvailabilityReader({
            readMaterializations: () => ({
                kind: 'available',
                availabilityCursor: 42,
                intentReads: [],
                materializations: [EXAMPLE_MATERIALIZATION],
                snapshots: [],
            }),
            readCurrentSettingsDeclaration: () => ({
                kind: 'unavailable',
                code: 'artifact_not_current',
            }),
        });
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.invocationLogs.targetStatus')?.props)
            .toMatchObject({
                title: 'settingsPlugins.invocationLogs.unavailableTitle',
                subtitle: 'settingsPlugins.invocationLogs.unavailableSubtitle',
                mode: 'info',
            });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('does not turn an unavailable Account admission into a plugin detail recovery route', async () => {
        state.value = {
            ...createState(),
            installedPluginById: new Map(),
        };
        accountAvailability.reader = createAccountAvailabilityReader({
            readMaterializations: () => ({
                kind: 'unavailable',
                code: 'account_availability_not_loaded',
            }),
            readCurrentSettingsDeclaration: () => ({
                kind: 'unavailable',
                code: 'account_availability_not_loaded',
            }),
        });
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        // Settled truth without the plugin keeps the deep link on the detail
        // route's missing-plugin state (it no longer redirects home); it must
        // still not become the Account recovery route.
        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.missing')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.detail.example.installed-plugin.accountRecovery')).toBeNull();
        expect(screen.findAllByType(PluginDetailLeaveActions)).toHaveLength(0);
    });

    it('passes the selected daemon target currentness guard to generic plugin Settings', async () => {
        const isDaemonSettingsTargetCurrent = vi.fn(() => true);
        state.value = {
            ...createState(),
            isDaemonSettingsTargetCurrent,
        };
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');

        await renderScreen(<PluginDetailScreen pluginId="example.installed-plugin" />);

        expect(genericSettingsProps).toHaveBeenCalledWith(expect.objectContaining({
            isDaemonTargetCurrent: isDaemonSettingsTargetCurrent,
        }));
    });
});
