import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { hasManagedMachinePresetCreationV1, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierBrandMark, type HostCatalogMark } from '@/components/ui/media/HappierBrandMark';
import { useServerInstalledPluginBrand } from '@/components/settings/plugins/PluginMark';
import { useBundledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { getPreferredLanguage, t } from '@/text';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import { launchPluginSurfaceAction } from '@/components/plugins/surfaces/launchPluginSurfaceAction';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMountedClientActionDemand } from '@/components/appShell/plugins/mountedClientActionDemand';
import type { PluginUiClientExecutableProjectionSource } from '@/components/plugins/reactNative/clientExecutableProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import type { PluginSurfaceActionDispatchOutcome } from '@/components/plugins/surfaces/actionFailure';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

export type ManagedProvisionerRepairFailure = Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>;

/** A repair failed; the catalog and its check still describe this provider. */
export function ManagedProvisionerRepairFailureNotice(props: Readonly<{ failure: ManagedProvisionerRepairFailure; testID: string }>) {
    const failure = props.failure;
    const fallback = failure.layer ? resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: failure.code }).body : t('pluginRuntime.actionFailed');
    const message = resolveActionExecutionFailureMessage({ ok: false, errorCode: failure.code,
        error: failure.message, details: failure.details }, fallback) ?? fallback;
    return <SurfaceStateCard testID={props.testID} kind="error" size="line" title={message}
        diagnosticCode={failure.reason} diagnosticDetail={failure.diagnostics?.join('\n')} />;
}

type Provisioner = MachineProvisionersListResultV1['provisioners'][number];
const selectInstallationId = (machine: Machine | null) => machine?.installationId;

/** A failed read is not a provider verdict; keep its cause human wherever the offer is drawn. */
export function describeManagedProvisionerFailure(code: string): string {
    if (code === 'machine-unavailable') return t('settingsProviders.detail.machineOffline');
    return readTransientAvailabilityFailure(code)?.message
        ?? resolveSystemTaskFailureMessage({ code })
        ?? t('managedMachines.providers.unavailable');
}
/** Public descriptor only; a preset projection never carries credential options or a native catalog occurrence. */
export function projectManagedPresetProvisioner(preset: Pick<ManagedMachinePresetV1, 'launch' | 'controller' | 'delegatedAcquire'> | null | undefined): Provisioner | undefined {
    return hasManagedMachinePresetCreationV1(preset) && preset.delegatedAcquire?.kind === 'ready' ? { contribution: preset.launch.provider,
        occurrenceId: 'preset', descriptor: preset.delegatedAcquire.provisioner, credentialPurposes: [] } : undefined;
}
// Identity, translations, credential titles and repair/option Actions are the
// presented question. Other Agent, tool and workflow inventories are unrelated.
const PRESENTATION_SECTIONS = ['familiesById.pluginUi', 'familiesById.machineProvisioners',
    'familiesById.connectedAccounts', 'actionsById', 'resourcesById'] as const;
// A mark alone reads the provisioner's descriptor (its icon) and its installed package, which every
// manifest carries: a row or rail mark never hydrates translations, credential titles or repair Actions.
const MARK_SECTIONS = ['familiesById.machineProvisioners'] as const;
/**
 * A provisioner's mark at each slot it stands in (lab `l12-kit.js` / `screens-x-machines.js`): a page
 * header, a receipt's identity or a provider tile, a list row, the collection rail. No tile behind it.
 */
export const MANAGED_PROVISIONER_MARK_SIZE = {
    header: 28,
    receipt: 22,
    tile: 22,
    row: 17,
    rail: 15,
} as const;

type ProvisionerMarkProps = Readonly<{
    pluginId?: string;
    icon?: string;
    size: number;
    installedPackage?: PluginProjectionInstalledPackageV2 | null;
    machineId?: string;
    serverId: string;
    /** The controller's projection is still loading and the descriptor's glyph isn't known yet. */
    resolving?: boolean;
}>;

/** The provisioner's identity: its package's contributed brand mark, else the glyph its descriptor names. */
function ManagedProvisionerMark(props: ProvisionerMarkProps) {
    if (props.installedPackage?.source.kind === 'bundled'
        || (props.installedPackage?.brand?.state === 'available' && props.machineId)) return <ManagedProvisionerBrandMark {...props} />;
    // Hold the mark's place blank rather than draw the generic glyph and swap it for the real one a moment later.
    if (props.resolving) return <View style={{ width: props.size, height: props.size }} />;
    return <ManagedProvisionerGlyph pluginId={props.installedPackage ? undefined : props.pluginId} icon={props.icon} size={props.size} />;
}

/** A brand stands for a provider only with its art; a name alone would be drawn as a second (letter) fallback. */
function withArt(brand: HostCatalogMark | null): HostCatalogMark | null {
    return brand && (brand.bytes || brand.light || brand.dark) ? brand : null;
}

function ManagedProvisionerBrandMark(props: ProvisionerMarkProps) {
    const brand = withArt(useServerInstalledPluginBrand(props));
    if (!props.installedPackage) return null;
    if (brand) return <HappierBrandMark brand={brand} externallyLabelled pixelSize={props.size} />;
    // Art that is on its way keeps its place blank; a package without art falls back like every other provider,
    // to the glyph its descriptor names, never a second (letter) fallback.
    if (props.installedPackage.brand?.state === 'available') return <View style={{ width: props.size, height: props.size }} />;
    return <ManagedProvisionerGlyph icon={props.icon} size={props.size} />;
}

function ManagedProvisionerGlyph(props: Readonly<{ pluginId?: string; icon?: string; size: number }>) {
    const brand = withArt(useBundledPluginBrandPresentation(props.pluginId));
    if (brand) return <HappierBrandMark brand={brand} externallyLabelled pixelSize={props.size} />;
    return <Icon name={resolvePluginContributedActionIconName(props.icon)} size={props.size} />;
}

/** Runtime host demand belongs to an open provider catalog or configurator. */
export function useManagedProvisionerRuntimeHost(input: Readonly<{
    serverId: string; accountScope?: ServerAccountScope | null;
}>) {
    const serverUrl = input.accountScope ? getServerProfileById(input.serverId)?.serverUrl : undefined;
    const [host, setHost] = React.useState<Readonly<{ serverUrl: string; value: 'browser' | 'native' | 'unavailable' }> | null>(null);
    React.useEffect(() => {
        if (!serverUrl) return;
        let active = true;
        void readRuntimeFetchHost(serverUrl).then(value => {
            if (active) setHost({ serverUrl, value });
        }, () => { if (active) setHost({ serverUrl, value: 'unavailable' }); });
        return () => { active = false; };
    }, [serverUrl]);
    return host?.serverUrl === serverUrl ? host?.value ?? null : null;
}

/** Catalog declarations own display identity; the selected controller's admitted bundles own translation. */
export function useManagedProvisionerPresentation(input: Readonly<{
    serverId: string; controller?: ManagedControllerV1; accountScope?: ServerAccountScope | null;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    provider?: Provisioner['contribution']; schemaVersion?: number;
    /** Changes when the person asks to read again: the projection is read anew. */
    refreshKey?: number;
    /** Only repair surfaces activate client Actions; marks demand only the identity sections they draw. */
    purpose?: 'presentation' | 'mark' | 'repair';
    onApprovalPending?: (registration: ActionApprovalContinuation) => void;
}>) {
    const pluginId = input.provisioner?.contribution.pluginId ?? input.provider?.pluginId;
    const accountReader = usePluginAccountAvailabilityReader(input.accountScope ?? null, pluginId, { enabled: !input.controller });
    const accountSelection = !input.controller && pluginId ? accountReader?.readCurrentAccountExecution(pluginId) : null;
    React.useEffect(() => {
        if (!input.controller && pluginId && accountReader && accountSelection?.kind === 'unavailable'
            && accountSelection.code === 'plugin_ui_declaration_pending') void accountReader.ensureCurrentAccountExecution(pluginId);
    }, [accountReader, input.controller, pluginId, accountSelection?.kind, accountSelection?.kind === 'unavailable' ? accountSelection.code : null]);
    const controllerInstallationId = useServerScopedMachine(input.serverId, input.controller?.machineId ?? '', selectInstallationId);
    const controllerAdmitted = !!input.controller && controllerInstallationId === input.controller.installationId;
    const { binding: controllerAccountLifetime } = useServerCredentialAccountScopeBinding(controllerAdmitted ? input.serverId : null);
    const projection = useDaemonMergedProjectionInputs({ serverId: input.serverId, machineId: controllerAdmitted ? input.controller?.machineId : undefined, enabled: controllerAdmitted,
        accountLifetime: controllerAccountLifetime,
        sections: input.purpose === 'mark' ? MARK_SECTIONS : PRESENTATION_SECTIONS,
        ...(input.refreshKey === undefined ? {} : { refreshKey: input.refreshKey }) });
    const uiProjection = input.controller ? projection.inputs?.pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION
        : accountReader?.readAccountUiProjection() ?? EMPTY_PLUGIN_UI_PROJECTION;
    const controllerMachineId = input.controller?.machineId;
    const clientActionSource = React.useMemo<PluginUiClientExecutableProjectionSource | null>(() =>
        input.purpose === 'repair' && controllerMachineId && projection.phase === 'ready'
            ? { projection: uiProjection, directMachineAuthority: { machineId: controllerMachineId, serverId: input.serverId } } : null,
    [controllerMachineId, input.purpose, input.serverId, projection.phase, uiProjection]);
    useMountedClientActionDemand(controllerAccountLifetime, clientActionSource);
    const accountReady = accountSelection?.kind === 'available';
    const locale = getPreferredLanguage();
    const qualifiedProviderKey = input.provider ? buildQualifiedPluginContributionKey(input.provider) : null;
    const projected = qualifiedProviderKey
        ? projection.inputs?.pluginProjectionV2?.familiesById.machineProvisioners?.entriesById[qualifiedProviderKey]
        : undefined;
    const bundled = qualifiedProviderKey ? BUNDLED_MACHINE_PROVISIONER_DECLARATIONS[qualifiedProviderKey] : undefined;
    const accountDescriptor = accountSelection?.kind === 'available' && input.provider
        ? accountSelection.manifest.contributes.machineProvisioners.find(descriptor => descriptor.id === input.provider?.localId
            && descriptor.schemaVersion === input.schemaVersion) : undefined;
    const provisioner = input.provisioner ?? (accountDescriptor && input.provider
        ? { contribution: input.provider, descriptor: accountDescriptor }
        : projected && projected.definition.schemaVersion === input.schemaVersion
        ? { contribution: { pluginId: projected.pluginId, localId: projected.definition.id }, descriptor: projected.definition }
        : bundled?.descriptor.schemaVersion === input.schemaVersion ? bundled : undefined);
    const localized = usePluginLocalizedTextResolver({
        projection: uiProjection,
        locale,
    });
    const currentController = React.useRef(input.controller);
    currentController.current = input.controller;
    const repair = async (action: NonNullable<ManagedPrerequisiteV1['repairAction']>, binding: ServerCredentialAccountScopeBinding,
        signal?: AbortSignal) => {
        const controller = input.controller;
        if (!controller || !binding.isCurrent()) return { ok: false as const, code: 'unavailable', reason: 'controller_unavailable' };
        if (projection.phase !== 'ready') {
            const reason = projection.failureReason ?? 'controller_unavailable';
            return { ok: false as const, code: 'unavailable', reason,
                ...(reason === 'machine-unavailable' ? { message: describeManagedProvisionerFailure(reason) } : {}) };
        }
        const result = await launchPluginSurfaceAction({ action: action.action, input: action.input,
            contributedAction: { machineId: controller.machineId, serverId: input.serverId, accountLifetime: binding,
                onApprovalPending: input.onApprovalPending },
            clientAction: {},
            hostAction: { execute: scopedHomeActionExecutor(binding.scope),
                context: { serverId: binding.scope.serverId, expectedAccountId: binding.scope.accountId } },
            pluginUiProjection: uiProjection, resolveContributedAction: createPluginUiProjectedActionResolver(uiProjection.actionsById),
            ...(signal ? { signal } : {}),
            isCurrent: () => binding.isCurrent() && currentController.current?.machineId === controller.machineId
                && currentController.current?.installationId === controller.installationId,
        });
        return result.outcome;
    };
    const installedPackages = projection.inputs?.pluginProjectionV2?.installedPackagesById;
    // The brand belongs to the package, so a launch whose definition this controller no longer projects
    // (another schema version) still carries its provider's mark.
    const markedProvisioner = provisioner ?? (input.provider ? { contribution: input.provider } : undefined);
    const projectionResolving = Boolean(input.controller) && !projection.inputs
        && (projection.phase === 'loading' || projection.phase === 'idle');
    // Each slot owner names the size it draws the mark at; the header's is the default.
    const markFor = (row?: Readonly<{ contribution: Provisioner['contribution']; descriptor?: Pick<Provisioner['descriptor'], 'icon'> }>,
        size: number = MANAGED_PROVISIONER_MARK_SIZE.header) => (
        <ManagedProvisionerMark pluginId={row?.contribution.pluginId} icon={row?.descriptor?.icon} size={size} resolving={!row?.descriptor?.icon && projectionResolving}
            installedPackage={row ? installedPackages?.[row.contribution.pluginId] : null} machineId={input.controller?.machineId} serverId={input.serverId} />
    );
    return { localized, title: provisioner ? localized(provisioner.contribution.pluginId, provisioner.descriptor.title) : null,
        descriptor: provisioner?.descriptor,
        billing: provisioner?.descriptor.billing,
        kindTitle: provisioner?.descriptor.kindTitle ? localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) : null,
        description: provisioner?.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : null,
        resourceIdPath: provisioner?.descriptor.resourceIdPath ?? null,
        mark: markFor(markedProvisioner), markAt: (size: number) => markFor(markedProvisioner, size), markFor,
        projection: uiProjection, projectionReady: input.controller ? projection.phase === 'ready' : accountReady,
        projectionFailed: input.controller ? projection.phase === 'error' || projection.phase === 'unsupported'
            : accountSelection?.kind === 'unavailable' && accountSelection.code !== 'plugin_ui_declaration_pending', repair };
}

/** A Preset as its mark reads it: creation (launch + controller) is optional; setup-only Presets have none. */
export type ManagedPresetMarkSource = Pick<ManagedMachinePresetV1, 'delegatedAcquire'> & Readonly<{
    launch?: ManagedMachinePresetV1['launch'] | null;
    controller?: ManagedMachinePresetV1['controller'] | null;
}>;

/**
 * A preset's mark (the rail, the machine picker, its page header): the provisioner its launch names, read
 * through its controller's projection like the preset page, at the size the row draws it. A setup-only
 * preset creates nothing, so it has no provider: it carries the setup glyph instead, never a guessed one.
 */
export function ManagedPresetMark(props: Readonly<{
    serverId: string;
    accountScope?: ServerAccountScope | null;
    preset: ManagedPresetMarkSource;
    size: number;
}>) {
    const { theme } = useUnistyles();
    const creation = hasManagedMachinePresetCreationV1(props.preset) ? props.preset : null;
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, accountScope: props.accountScope,
        controller: creation && !creation.delegatedAcquire ? creation.controller : undefined,
        provisioner: projectManagedPresetProvisioner(creation),
        provider: creation?.launch.provider, schemaVersion: creation?.launch.schemaVersion, purpose: 'mark' });
    return creation ? presentation.markAt(props.size)
        : <Icon name={MACHINE_SETUP_PRESET_GLYPH} size={props.size} color={theme.colors.text.secondary} />;
}

/** The glyph a setup-only preset stands under (lab `setup/over` Tools row): what it sets up, not who makes it. */
export const MACHINE_SETUP_PRESET_GLYPH = 'wrench';
