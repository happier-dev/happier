import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildManagedMachineAcquireInput, runManagedMachineCreation } from './managedMachineCreation';
import * as React from 'react';
import { readMachineProvisionerHostAvailability } from '@happier-dev/cli-common/machines/managed/provisioners';
import { showManagedGetTheAppModal } from './ManagedGetTheAppModal';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { describeManagedActionFailureDiagnostic, describeManagedNativeFailureDiagnostic } from './managedNativeFailurePresentation';
import { randomUUID } from '@/platform/randomUUID';
import type { OpenedMachinePresetActionOutputV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
type PresetMutationResultV1 = OpenedMachinePresetActionOutputV1<'machines.presets.update'>;
import { hasOpenedManagedMachinePresetCreationV1, type OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { machinePresetEditContinuationDraft, type MachinePresetEditContinuation, type MachinePresetEditDraft } from './machinePresetEditDraft';
import { createManagedCredentialSelectionV1, readManagedCredentialSelectionValueV1, type ManagedControllerV1, type ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ExternalActionManagedAdmissionReceiptV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ManagedAcquireInputV1, ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectManagedProvisionerFailure, type ManagedProvisionerFailure } from './managedProvisionerClient';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { isMachineProvisionerCredentialPurposeRequiredV1, readMachineProvisionerCredentialPurposeSelectorPathsV1, readMachineProvisionerPrerequisitesV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { ConnectedAccountActionFormSelectionV1Schema, qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { seedInputByFieldHints, writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { isMachineRetainedWakeEligibleV1, resolveMachineRetentionPolicyV1, supportedMachineRetentionEffectsV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { useIsMachineListSettled, useServerScopedMachine } from '@/sync/store/hooks';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { Modal } from '@/modal';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { getPreferredLanguage, t } from '@/text';
import { useManagedProvisioners } from './useManagedProvisioners';
import { useManagedMachineAccountSettings } from './useManagedMachineAccountSettings';
import { describeManagedProvisionerFailure, ManagedPresetMark, MANAGED_PROVISIONER_MARK_SIZE, ManagedProvisionerRepairFailureNotice, useManagedProvisionerPresentation, useManagedProvisionerRuntimeHost, projectManagedPresetProvisioner, type ManagedProvisionerRepairFailure } from './useManagedProvisionerPresentation';
import { createPluginSurfaceActionFailure } from '@/components/plugins/surfaces/actionFailure';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';
import { readManagedConfiguration } from './readManagedConfiguration';
import { useSettledSelectors } from './useSettledSelectors';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { buildSessionActionFieldOptionsResolver } from '@/components/sessions/actions/sessionActionFieldOptions';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { actionInputOptionValueKey, resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { deriveActionInputHints } from '@happier-dev/protocol/actions/schemaInputHints';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { readDeclaredConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { createMachinePresetCollectionClient } from './machinePresetCollectionClient';
import type { MachinePresetCollectionOptions, MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';
import { useMachinePresetQuery, useMachinePresets, isMachinePresetAccessLost } from './useMachinePresets';
import { ManagedStartFromSection, managedStartFromPresets } from './ManagedStartFromSection';
import { showManagedCreationReview } from './ManagedCreationReview';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readMachineSetupRecipeInputState } from './machineSetupRecipeInputsModel';
import { isAuthoritativeScopedSnapshotRefusal } from '@/sync/domains/scope/scopedSnapshotFacts';
import { ManagedScopeRow } from './ManagedScopeRow';
import { ManagedPresetControllerSection } from './ManagedPresetControllerSection';
import { useMachinePoolName, useMachinePoolView } from '@/sync/engine/machines/useMachinePoolProjections';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { ManagedMachineConfigurator } from './ManagedMachineConfigurator';
import { ManagedCreationDisabledBanner } from './ManagedMachineStateRow';
import { useManagedControllerScope } from './useManagedControllerScope';
import { buildManagedConfigurationReceipt, describeLocalHeadroom, describeManagedConfigurationSummary, formatManagedSizeBytes, managedAgentSignInReceiptFacts, managedCredentialReceiptTargets, managedCredentialPresentations } from './managedConfigurationPresentation';
import { MachineSetupSection, describeMachineSetup } from './MachineSetupSection';
import { ManagedEnrollmentIdentitySection, isManagedEnrollmentIdentityReviewed } from './ManagedEnrollmentIdentitySection';
import { ManagedFieldRow, managedPresetLimitRow } from './MachinePresetDetail';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions, refreshManagedConfiguratorProvisioner, beginManagedConfiguratorRead, settleManagedConfiguratorRead,
    managedConfiguratorFacts, managedConfiguratorPresetLaunch, managedConfiguratorProjection, managedConfiguratorMissingDimension, managedConfiguratorAcquireInput, resolveManagedConfiguratorAcquireDraft, managedConfiguratorOptionsSelectors, setManagedConfiguratorOptionsSelectors, setManagedConfiguratorCredentials, managedConfiguratorCredentialSelections, managedConfiguratorCapabilities,
    type ManagedConfiguratorDraft } from './managedConfiguratorModel';
import { describeKeepCosts, describeRetentionConsequence } from './managedRetentionPresentation';
import { useAgentSignInTargets } from '@/components/settings/connectedServices/defaults/useAgentSignInTargets';
import { countryName } from './managedMachineDisplay';
import { formatProviderAmount, formatPriceUnit, presentManagedCost } from '@/components/ui/presentation/providerCostPresentation';
import { ManagedImagePreview, useManagedImagePreviews } from './useManagedImagePreviews';
import { refreshManagedProvisionerAvailability } from './managedProvisionerAvailability';
import { ManagedSizeTable, ManagedImageTiles, ManagedLocationGroup, ManagedNetworkGroup } from './ManagedChoiceSections';
import { managedConfiguratorChoiceOwnsField, managedConfiguratorDimensionChoices, managedConfiguratorDimensionSelection, managedConfiguratorEnrollmentDefault, selectManagedConfiguratorDimension } from './managedConfiguratorModel';
import { createManagedMachineSelectionDraft, type ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedMachineUse } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRetentionDuration } from './managedRetentionPresentation';
import { presentConnectSheet } from '../../connectedServices/setup/ConnectedServiceSetupModal';
import { ConnectedServiceMark } from '../../connectedServices/ConnectedServiceMark';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveConnectedServiceSettingsErrorMessage } from '../../connectedServices/connectedServiceSettingsErrors';
import { resolveConnectedAccountPurposeSetupHandoff, type ConnectedAccountPurposeSetupHandoff } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

const MORE_TEAMS = '__more-teams';

export type ManagedMachineConfigurationViewProps = Readonly<{
    serverId: string; provisioner: string; presetId?: string; presetOnly?: boolean; initialController?: ManagedControllerV1;
    /** A preset authored for one machine's Isolation (the add-sandbox sheet) is that machine's own: no Who can use it or Running at once. */
    presetFor?: 'isolation';
    /** Authored inside a sheet: the configurator draws one column and publishes Save as the sheet's footer. */
    sheetFooter?: (footer: React.ReactNode | null) => void;
    /** Isolation asks the selected launch's canonical declaration for local hosting. */
    sessionPlacement?: 'controller-local';
    /** Exact caller-supplied native query; never inferred from the viewing device's filesystem. */
    initialOptionsSelectors?: Readonly<Record<string, unknown>>;
    initialEnrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
    initialConnectPurpose?: string;
    /** A retained creation flow keeps the admitted resource here rather than opening the Machine route. */
    onCreated?: (machine: Readonly<{ serverId: string; managedId: string }>) => void;
    /** The host's Back shares the receipt's busy lifecycle, so acquisition cannot lose its result. */
    onCancel?: () => void;
    /** Composer review returns intent; its creation owner admits any requested acquisition. */
    onUse?: ManagedMachineUse;
    /** Add returns to the original composer, whose creation owner creates only the Machine. */
    createOnUse?: boolean;
    /**
     * Opened from a composer holding a drafted prompt (58d receipt, Q2): the one primary press is "Create and start
     * a session", which uses the machine and asks the composer's own Send to run (`{ send: true }`).
     */
    startsSession?: boolean;
    /** Add-to-Preset hand-off: the editor starts from this draft plus the item, and returns after its own Save or Cancel. */
    presetContinuation?: MachinePresetEditContinuation;
    /** A host that embeds new-preset authoring (Machine Isolation's add flow) keeps the saved preset instead of opening its page. */
    onPresetSaved?: (preset: Readonly<{ serverId: string; id: string; name: string }>) => void;
}>;
const NO_SERVERS: readonly string[] = [];
const NO_PRESETS: readonly OpenedManagedMachinePresetV1[] = [];

export function isManagedPoolUnavailableAtReview(view: Pick<MachinePoolViewV1, 'availability'> | null, reviewable: boolean): boolean {
    return reviewable && view?.availability.state === 'known' && view.availability.connectedCount === 0;
}

export function ManagedMachineConfigurationView(props: ManagedMachineConfigurationViewProps) {
    // "Start from" is chosen above the per-preset draft below, so its own list stays while that draft is re-read.
    const offersStartFrom = !props.presetOnly && (!props.onUse || props.createOnUse === true) && !!props.provisioner;
    const serverIds = React.useMemo(() => offersStartFrom ? [props.serverId] : NO_SERVERS, [offersStartFrom, props.serverId]);
    const presets = useMachinePresets(serverIds);
    const listed = presets.presetsByServerId[props.serverId] ?? NO_PRESETS;
    // Start from sits above the form; until the list has answered the form holds its place rather than being pushed down mid-typing.
    const startFromPending = offersStartFrom && !presets.statesByServerId[props.serverId]?.value && presets.statesByServerId[props.serverId]?.loading !== false;
    const startFromPresets = React.useMemo(() => managedStartFromPresets(listed, props.provisioner), [listed, props.provisioner]);
    const [startFrom, setStartFrom] = React.useState<Readonly<{ routePresetId: string | undefined; presetId: string | undefined }> | null>(null);
    const presetId = startFrom && startFrom.routePresetId === props.presetId ? startFrom.presetId : props.presetId;
    const routePresetId = props.presetId;
    const onStartFromChange = React.useCallback((next: string | null) =>
        setStartFrom({ routePresetId, presetId: next ?? undefined }), [routePresetId]);
    const showsStartFrom = offersStartFrom && startFromPresets.length > 0 && (!presetId || startFromPresets.some(preset => preset.id === presetId));
    return <ManagedMachineConfigurationViewBody key={JSON.stringify([props.serverId, props.provisioner, presetId, props.initialOptionsSelectors])} {...props} presetId={presetId}
        startFrom={showsStartFrom ? { presets: startFromPresets, onChange: onStartFromChange } : undefined} startFromPending={startFromPending} />;
}
function ManagedMachineConfigurationViewBody(props: ManagedMachineConfigurationViewProps & Readonly<{
    startFrom?: Readonly<{ presets: readonly OpenedManagedMachinePresetV1[]; onChange: (presetId: string | null) => void }>;
    startFromPending: boolean;
}>) {
    const approvalHandler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => approvalHandler.current(registration), []);
    const router = useRouter();
    const compact = useViewportClass() === 'compact';
    const machineListSettled = useIsMachineListSettled(props.serverId);
    const [draft, setDraft] = React.useState<ManagedConfiguratorDraft | null>(null);
    // A setup-only preset (no creation part) is edited in this same editor: only its name and setup, no provider.
    const setupOnlyEdit = props.presetOnly === true && !!props.presetId && !props.provisioner;
    const [setupOnlyDraft, setSetupOnlyDraft] = React.useState<MachinePresetEditDraft | null>(null);
    const [preset, setPreset] = React.useState<OpenedManagedMachinePresetV1 | null>(null);
    const creationPreset = hasOpenedManagedMachinePresetCreationV1(preset) ? preset : undefined;
    const pooledDraft = draft ? draft.controllerPoolId !== undefined : creationPreset?.controllerPoolId !== undefined;
    const targetEdited = props.presetOnly && draft && (draft.controllerPoolId !== creationPreset?.controllerPoolId
        || !pluginJsonValuesEqual(draft.controller ?? null, creationPreset?.controller ?? null));
    const delegatedPreset = !props.presetOnly && !targetEdited && creationPreset?.teamAcquireDelegated === true;
    const poolId = pooledDraft ? draft?.controllerPoolId ?? creationPreset?.controllerPoolId : undefined;
    const poolView = useMachinePoolView(props.serverId, poolId);
    // The shared Pool projection already owns the current availability answer. A known zero-connected
    // pool cannot satisfy Use or Create; show its typed refusal at review before either is attempted.
    const poolUnavailableAtReview = isManagedPoolUnavailableAtReview(poolView, !props.presetOnly && poolId !== undefined);
    const [delegatedName, setDelegatedName] = React.useState<string | null>(null);
    const loadedPreset = React.useRef<OpenedManagedMachinePresetV1 | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [repairFailure, setRepairFailure] = React.useState<Readonly<{
        binding: ServerCredentialAccountScopeBinding; controller: ManagedControllerV1 | undefined;
        provisioner: string; outcome: ManagedProvisionerRepairFailure;
    }> | null>(null);
    const [accountSetup, setAccountSetup] = React.useState<ConnectedAccountPurposeSetupHandoff | null>(null);
    const [pendingCredential, setPendingCredential] = React.useState<Readonly<{
        setup: NonNullable<typeof accountSetup>; account: QualifiedConnectedAccountRef;
    }> | null>(null);
    // "Managed from" is the page's scope: the header chip, starting on the handed-off or preset controller.
    const scope = useManagedControllerScope({ serverId: props.serverId, preferred: delegatedPreset ? creationPreset?.controller : props.initialController ?? creationPreset?.controller,
        observeThisComputer: !props.presetOnly,
        delegatedPreset,
        disabled: busy, testIDPrefix: 'managed-config.controller',
        onSelect: React.useCallback((next: ManagedControllerV1) => setDraft(current => current
            ? { ...current, controller: next, controllerPoolId: undefined, check: undefined, optionStatus: 'loading' } : current), []) });
    // Retain the selected computer until the shared host decision places this provisioner's acquire role.
    const [acquireTarget, setAcquireTarget] = React.useState<'account' | 'daemon' | undefined>();
    const accountAcquire = !props.presetOnly && !creationPreset && acquireTarget === 'account';
    // Pool authoring reads choices in the existing controller scope; acquire alone binds its target.
    const controllerCandidate = pooledDraft ? delegatedPreset ? undefined : scope.controller
        : creationPreset ? draft ? draft.controller : creationPreset.controller : draft?.controller ?? scope.controller;
    const requestedController = accountAcquire ? undefined : controllerCandidate;
    const requestedControllerPresent = useServerScopedMachine(props.serverId, requestedController?.machineId,
        React.useCallback((machine: Machine | null) => !!machine && isMachineVisibleForSelection(machine)
            && machine.installationId === requestedController?.installationId, [requestedController?.installationId]));
    const catalogController = !props.presetOnly && (!props.presetId || !!creationPreset) && !delegatedPreset && requestedController && requestedControllerPresent
        ? requestedController : undefined;
    const catalogPlacementAvailable = props.presetOnly || requestedController === undefined || catalogController !== undefined;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, catalogController,
        { enabled: !setupOnlyEdit && (!delegatedPreset || props.presetOnly) && catalogPlacementAvailable && (!props.presetId || !!creationPreset),
            contributionKey: props.presetOnly ? undefined : props.provisioner });
    const accountHost = useManagedProvisionerRuntimeHost({ serverId: props.serverId, accountScope: props.presetOnly ? undefined : catalog.binding?.scope });
    // A page that names its controller (deep link, reload, handoff) before the Home's machine list has synced
    // has not been refused anything: it waits for the list that will either contain the controller or not.
    const controllerAwaitsMachineList = !props.presetOnly && !delegatedPreset && !!requestedController && !catalogController && !machineListSettled;
    const accountSettings = useManagedMachineAccountSettings(catalog.binding, catalog.resolution);
    const [teamId, setTeamId] = React.useState('');
    const [limit, setLimit] = React.useState<number | undefined>();
    // One failure line for the page; it names the operation that failed so a refused Create or Save isn't told as a read.
    const [error, setErrorState] = React.useState<Readonly<{ code: string; during: 'read' | 'create' | 'save'; reason?: string; diagnosticDetail?: string }> | null>(null);
    const setError = React.useCallback((code: string | null, during: 'read' | 'create' | 'save' = 'read', reason?: string, diagnosticDetail?: string) =>
        setErrorState(current => current?.code === code && current.during === during && current.reason === reason && current.diagnosticDetail === diagnosticDetail ? current
            : code === null ? null : { code, during, ...(reason ? { reason } : {}), ...(diagnosticDetail ? { diagnosticDetail } : {}) }), []);
    const [readRevision, bumpReadRevision] = React.useReducer((value: number) => value + 1, 0);
    const [saved, setSaved] = React.useState<Readonly<{ id: string; name: string; serverId: string }> | null>(null);
    const continuation = props.presetContinuation;
    // The item joins the hand-off draft through the canonical union; a differing copy of it already there is a conflict.
    const continuationSetup = React.useMemo(() => continuation
        ? machinePresetEditContinuationDraft(continuation) : undefined, [continuation]);
    const continuationSeed = continuationSetup?.ok ? continuationSetup.draft.setup : continuation?.draft.setup;
    const continuationEntered = React.useRef(false);
    const approval = useActionApprovalContinuation({ serverId: props.serverId,
        scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId, props.provisioner]), onExecuted: () => {} });
    approvalHandler.current = approval.requestApproval;
    const mutationAbort = React.useRef<AbortController | null>(null);
    const optionsAbort = React.useRef<AbortController | null>(null);
    const reviewed = React.useRef<ManagedConfigurationFactsV1 | null>(null);
    const catalogProvisioner = catalog.provisioners.find(row => buildQualifiedPluginContributionKey(row.contribution) === props.provisioner);
    // Retry refreshes refused form reads along with native options.
    const retry = () => {
        if (optionsInput.kind === 'unavailable' || launchFormUnreadable) bumpReadRevision();
        if (catalog.binding && catalog.homeId && catalogProvisioner) refreshManagedProvisionerAvailability(catalog.binding,
            { homeId: catalog.homeId, ...(controller ? { controller } : {}), contribution: catalogProvisioner.contribution });
        readOptions();
    };
    // Adopted in this render, so no effect ever sees a draft placed by the other role.
    const declaredAcquireTarget = catalogProvisioner?.acquireExecutionTarget;
    const hostAvailability = !props.presetOnly && !pooledDraft && catalogProvisioner && declaredAcquireTarget && accountHost !== null && accountHost !== 'unavailable'
        ? readMachineProvisionerHostAvailability({ ...accountHost, provisioner: catalogProvisioner.descriptor,
            acquireExecutionTarget: declaredAcquireTarget, controller: controllerCandidate }) : null;
    const effectiveAcquireTarget = creationPreset || declaredAcquireTarget === 'daemon' ? declaredAcquireTarget : hostAvailability?.executionTarget;
    if (effectiveAcquireTarget && effectiveAcquireTarget !== acquireTarget) setAcquireTarget(effectiveAcquireTarget);
    // Host discovery follows the catalog's Account binding. Do not create a controller-bound draft until it settles.
    const accountHostPending = !props.presetOnly && declaredAcquireTarget === 'account' && accountHost === null;
    const accountHostUnreadable = !props.presetOnly && declaredAcquireTarget === 'account' && accountHost === 'unavailable';
    const needsApp = hostAvailability?.available === false && !hostAvailability.requiresController;
    const pageChip = accountAcquire || pooledDraft || props.presetOnly ? null : scope.chip;
    // A retained catalog remains readable while the selected controller answers, but cannot admit credential-bearing work.
    const catalogCurrent = catalog.current;
    // Async authentication callbacks read the current mounted handoff, never a retired render's draft.
    const purposeHandoff = React.useRef({ activeHandoff: accountSetup, pendingCredential, binding: catalog.binding,
        controller: catalogController, provisioner: catalogProvisioner, available: catalogCurrent });
    purposeHandoff.current = { activeHandoff: accountSetup, pendingCredential, binding: catalog.binding,
        controller: catalogController, provisioner: catalogProvisioner, available: catalogCurrent };
    const openAccountSetup = async (purposeId: string) => {
        const binding = catalog.binding;
        const purpose = catalogProvisioner?.credentialPurposes?.find(entry => entry.purpose.purpose === purposeId)?.purpose;
        if (!catalogCurrent || !draft || !binding?.isCurrent() || !catalogProvisioner || !purpose || busy
            || !accountAcquire && (!catalogController || !scope.selection)) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const credential = draft.credentials?.find(entry => qualifiedPurposeKey(entry.purpose) === qualifiedPurposeKey(purpose));
        const selected = credential && 'account' in credential ? credential.account : null;
        const setup: ConnectedAccountPurposeSetupHandoff = { request: { scope: binding.scope, ...(catalogController ? { machineId: catalogController.machineId } : {}), purpose }, lifetime,
            ...(catalogController ? { controller: catalogController } : {}), occurrenceId: catalogProvisioner.occurrenceId };
        const selection = accountAcquire ? undefined : scope.selection;
        const services = readDeclaredConnectedAccountPurposeV1({ purpose, projection: presentation.projection,
            machineProvisionersById: presentation.projection.machineProvisionersById })?.serviceRefs;
        setAccountSetup(setup);
        try {
            const result = await presentConnectSheet({ service: selected?.service ?? (services?.length === 1 ? services[0] : undefined),
                purpose, account: selected ?? undefined, purposeRequest: setup.request, intent: 'link',
                ...(selection ? { targetSelection: { ...selection, resolveExecutionTarget: () => {
                    const target = selection.resolveExecutionTarget() ?? null;
                    return resolveConnectedAccountPurposeSetupHandoff(setup, { ...purposeHandoff.current,
                        controller: target ? { machineId: target.machine.id, installationId: target.machine.installationId } : undefined }).ok ? target : null;
                } } } : {}) });
            if (result.kind === 'dismissed') return;
            const handoff = resolveConnectedAccountPurposeSetupHandoff(setup, purposeHandoff.current);
            if (!handoff.ok) throw handoff.error;
            setPendingCredential({ setup, account: result.account });
            catalog.refresh();
        } catch (error) {
            Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
        } finally {
            setAccountSetup(null);
        }
    };
    const initialConnectConsumed = React.useRef(false);
    React.useEffect(() => {
        if (props.presetOnly || initialConnectConsumed.current || !props.initialConnectPurpose || !catalogCurrent || !draft || !catalogProvisioner) return;
        initialConnectConsumed.current = true;
        void openAccountSetup(props.initialConnectPurpose);
    }, [props.presetOnly, props.initialConnectPurpose, catalogCurrent, draft, catalogProvisioner, catalogController]);
    // Only this occurrence's controller-qualified catalog authorizes purpose choices. Account inventory is display-only.
    const credentialPurposes = props.presetOnly ? undefined : catalogProvisioner?.credentialPurposes;
    const requiredCredentialPurposes = React.useMemo(() => catalogProvisioner?.credentialPurposes?.filter(({ purpose }) =>
        isMachineProvisionerCredentialPurposeRequiredV1(catalogProvisioner.descriptor, purpose.purpose,
            draft?.optionsSelectors ?? draft?.selected?.launch)), [catalogProvisioner, draft?.optionsSelectors, draft?.selected]);
    const credentialSelections = React.useMemo(() => draft && catalogProvisioner
        ? managedConfiguratorCredentialSelections(draft, catalogProvisioner) : [], [catalogProvisioner, draft?.credentials, draft?.optionsSelectors, draft?.selected]);
    const requiredCredentials = draft?.credentials?.filter(credential => !catalogProvisioner || isMachineProvisionerCredentialPurposeRequiredV1(
        catalogProvisioner.descriptor, credential.purpose.purpose, draft.optionsSelectors ?? draft.selected?.launch)) ?? [];
    const requiredCredentialSelections = credentialSelections.filter(credential => requiredCredentialPurposes?.some(({ purpose }) =>
        qualifiedPurposeKey(purpose) === qualifiedPurposeKey(credential.purpose)));
    const credentialsCurrent = pluginJsonValuesEqual(requiredCredentials, requiredCredentialSelections);
    const credentialsReady = delegatedPreset || requiredCredentialPurposes !== undefined
        && requiredCredentialSelections.length === requiredCredentialPurposes.length && credentialsCurrent;
    const credentialInput = React.useMemo(() => Object.fromEntries((credentialPurposes ?? []).map(({ purpose }, index) => {
        const selected = credentialSelections.find(credential => qualifiedPurposeKey(credential.purpose) === qualifiedPurposeKey(purpose));
        return [String(index), selected ? readManagedCredentialSelectionValueV1(selected) : undefined];
    })), [credentialPurposes, credentialSelections]);
    // A retained draft describes what was reviewed; only the current catalog admits new reads or mutations.
    const retainedProvisioner = catalogProvisioner ?? draft?.provisioner;
    const controller = hostAvailability ? hostAvailability.controller : requestedController;
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: catalogController, accountScope: catalog.binding?.scope, provisioner: retainedProvisioner, refreshKey: readRevision,
        provider: creationPreset?.launch.provider, schemaVersion: creationPreset?.launch.schemaVersion,
        purpose: props.presetOnly ? 'presentation' : 'repair', declarationsOnly: props.presetOnly, onApprovalPending });
    const provisioner = retainedProvisioner ?? projectManagedPresetProvisioner(creationPreset, presentation.descriptor);
    const optionsInput = useManagedProvisionerOptionsInput({ binding: catalog.binding, controller: catalogController,
        provisioner: delegatedPreset && !props.presetOnly ? undefined : catalogProvisioner,
        declarationsOnly: props.presetOnly, refreshKey: readRevision });
    const localizeActionText = usePluginLocalizedTextResolver({ projection: presentation.projection });
    // The account a purpose draws on is named by its service, never by the purpose id.
    const connectedServices = useProjectedConnectedServicesRegistry();
    const localizeServiceText = useProjectedPluginLocalizedTextResolver();
    const purposeService = React.useCallback((purpose: string) => (provisioner && readDeclaredConnectedAccountPurposeV1({
        purpose: { consumer: provisioner.contribution, purpose }, projection: presentation.projection,
        machineProvisionersById: presentation.projection.machineProvisionersById })?.serviceRefs[0]) || undefined,
    [provisioner, presentation.projection]);
    const purposeAccountTitle = React.useCallback((purpose: string) => {
        const service = purposeService(purpose);
        return service ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServices, service, t, localizeServiceText) : undefined;
    }, [purposeService, connectedServices, localizeServiceText]);
    const credentialFieldOptions = React.useMemo(() => buildSessionActionFieldOptionsResolver({}), []);
    // The form comes from the catalog occurrence's own options Action. `missing` means the controller's presentation
    // doesn't describe that occurrence (not loaded, or still an earlier one after a plugin reload).
    const optionPresentation = React.useMemo(() => {
        if (optionsInput.kind !== 'ready') return { hints: undefined, missing: false };
        const projected = createPluginUiProjectedActionResolver(presentation.projection.actionsById)({
            pluginId: optionsInput.action.pluginId, localId: optionsInput.action.id });
        const action = optionsInput.presentation ?? (projected?.occurrenceId === optionsInput.action.occurrenceId ? projected : undefined);
        if (!action) return { hints: undefined, missing: true };
        return { hints: resolvePluginProjectedActionPresentation({ pluginId: optionsInput.action.pluginId,
            presentation: action, projection: presentation.projection, localize: localizeActionText }).inputHints ?? undefined, missing: false };
    }, [optionsInput, presentation.projection, localizeActionText]);
    // The declared options input names what a person authors; launch may also require native-derived facts.
    const optionHints = React.useMemo(() => props.presetOnly
        ? deriveActionInputHints(optionsInput.kind === 'ready' ? optionsInput.schema
            : optionsInput.kind === 'none' ? provisioner?.descriptor.launchSchema : undefined, optionPresentation.hints)
        : optionPresentation.hints,
    [props.presetOnly, optionsInput, provisioner?.descriptor.launchSchema, optionPresentation.hints]);
    const launchPresentationPending = !delegatedPreset && !optionHints && !presentation.projectionReady && !presentation.projectionFailed;
    // Settled without the form: say so with a re-read, rather than offering a size nobody can edit (R93).
    const launchFormUnreadable = optionPresentation.missing && !launchPresentationPending;
    const selectors = React.useMemo(() => draft && optionsInput.kind === 'ready'
        ? managedConfiguratorOptionsSelectors(draft, optionsInput.schema, optionHints) : null,
        [draft?.optionsSelectors, draft?.selected, draft?.preset, optionsInput, optionHints]);
    const selectorKey = JSON.stringify(selectors);
    // The fields show the live draft; the provider is asked once the person pauses editing.
    const readSelectors = useSettledSelectors(selectors, selectorKey);
    const readSelectorKey = JSON.stringify(readSelectors);
    // The fields show what the read is asked with: the person's values over the provider's declared defaults.
    const fieldInput = React.useMemo<Record<string, unknown>>(() => {
        let base = draft?.optionsSelectors ? { ...draft.optionsSelectors }
            : selectors && typeof selectors === 'object' && !Array.isArray(selectors) ? { ...selectors } : {};
        if (draft?.preset) return base;
        // Only declared form fields consume native defaults. Fixed launch facts (for example
        // Cua's `on`) are not options operands, and deliberate edits remain authoritative.
        const defaults = draft?.selected?.launch ?? draft?.options?.base?.launch;
        for (const field of optionHints?.fields ?? []) {
            const value = readInputPath(defaults, field.path);
            if (value !== undefined && readInputPath(base, field.path) === undefined) base = writeInputPath(base, field.path, value);
        }
        return seedInputByFieldHints({ inputHints: optionHints }, base);
    }, [props.presetOnly, draft?.optionsSelectors, draft?.selected, draft?.options?.base?.launch, draft?.preset, selectorKey, optionHints]);
    // Fields the provider fills with its own defaults (a store, an image location, a driver) are reviewed rarely: they
    // fold into one Advanced disclosure. The set is decided once, when the provider first answers, so no field moves
    // while the person types; a required field it left blank stays in view.
    const advancedPaths = React.useRef<Readonly<{ key: string; paths: ReadonlySet<string> }> | null>(null);
    const [advancedOpen, setAdvancedOpen] = React.useState(false);
    const fields = React.useMemo(() => props.presetOnly || optionsInput.kind === 'ready'
        ? resolveEffectiveActionInputFields({ inputHints: optionHints }, fieldInput) : [],
        [props.presetOnly, optionsInput, optionHints, fieldInput]);
    const fieldRequests = React.useMemo(() => optionsInput.kind === 'ready' ? fields.map(field => ({ field,
        actionId: buildQualifiedPluginContributionKey({ pluginId: optionsInput.action.pluginId, localId: optionsInput.action.id }), draftInput: fieldInput })) : [],
        [fields, fieldInput, optionsInput]);
    const { localized, mark } = presentation;
    const receiptMark = presentation.markAt(MANAGED_PROVISIONER_MARK_SIZE.receipt);
    const title = presentation.title ?? '';
    const homeName = resolveHomeDisplayLabel(getServerProfileById(props.serverId), props.serverId);
    const teams = useTeamsDirectory({ serverIds: [props.serverId], enabled: !!draft });
    const team = useTeamBinding(props.serverId, teamId || (preset?.owner.kind === 'team' ? preset.owner.teamId : ''));
    const teamWritable = !teamId && preset?.owner.kind !== 'team' && (!preset || preset.owner.kind === 'account' && preset.owner.accountId === catalog.binding?.accountId)
        || team.kind === 'bound' && team.state.kind === 'ready'
        && team.state.mutationsAvailable && team.state.team.capabilities.manageSettings;
    const presetClient = React.useMemo(() => catalog.binding && catalog.homeId ? createMachinePresetCollectionClient(catalog.binding.scope, catalog.homeId) : null, [catalog.binding, catalog.homeId]);
    const retirePending = React.useCallback(() => {
        mutationAbort.current?.abort(); optionsAbort.current?.abort(); setBusy(false);
    }, []);
    const clearProtectedPreset = React.useCallback((code: string) => {
        retirePending(); reviewed.current = null; loadedPreset.current = null;
        setDraft(null); setPreset(null); setLimit(undefined); setSaved(null); setError(code);
        setAccountSetup(null); setPendingCredential(null); setTeamId('');
    }, [retirePending]);
    const readPreset = React.useMemo(() => presetClient && catalog.homeId && props.presetId
        ? async (options: MachinePresetCollectionOptions<OpenedManagedMachinePresetV1>): Promise<MachinePresetCollectionSettledResult<OpenedManagedMachinePresetV1>> => {
            const result = await presetClient.read('machines.presets.get', { homeId: catalog.homeId!, id: props.presetId! },
                { signal: options.signal, onApprovalPending: options.onApprovalPending });
            if (result.kind === 'failed') return result;
            return result.value.kind === 'found' ? { kind: 'succeeded', value: result.value.preset }
                : { kind: 'failed', code: result.value.code };
        } : null, [presetClient, catalog.homeId, props.presetId]);
    const presetQuery = useMachinePresetQuery({ serverId: props.serverId, homeId: catalog.homeId, presetId: props.presetId,
        binding: catalog.binding, resolution: catalog.resolution, read: readPreset, refreshRevision: readRevision, onApprovalPending,
        onAccessLost: clearProtectedPreset, onInvalidated: retry });
    const fieldOptions = useInputFieldOptions({ requests: fieldRequests, enabled: !props.presetOnly && catalogCurrent && presetQuery.sameScope && !!draft && credentialsReady && optionsInput.kind === 'ready',
        serverId: catalog.binding?.serverId ?? props.serverId, machineId: controller?.machineId, accountLifetime: catalog.binding });
    const teamDenied = !!props.presetId && (preset?.owner.kind === 'team' || !!teamId) && team.kind === 'bound'
        && (team.state.kind === 'ready' && !team.state.team.capabilities.viewTeam
            || team.state.kind === 'unavailable' && isAuthoritativeScopedSnapshotRefusal(team.state.error));
    React.useEffect(() => {
        if (teamDenied && presetQuery.state.value) presetQuery.withdraw('permission_denied');
    }, [teamDenied, presetQuery.state.value, presetQuery.withdraw]);
    React.useEffect(() => {
        if (!presetQuery.sameScope || !catalogPlacementAvailable || props.presetId || !provisioner || accountHostPending || accountHostUnreadable) return;
        const initial = props.presetOnly ? requestedController : catalogController;
        setDraft(current => current ?? createManagedConfiguratorDraft({ provisioner, controller: initial,
            // A new preset started from a Store door has no name yet: it takes the provider's, as Add does.
            name: continuation?.draft.name || title,
            optionsSelectors: props.initialOptionsSelectors, enrollmentIdentity: props.initialEnrollmentIdentity,
            ...(continuation ? { setup: continuationSeed } : {}) }));
        if (continuation && !continuationEntered.current) {
            continuationEntered.current = true;
            if (continuationSetup?.ok === false) setError('machine_setup_conflict', 'save');
        }
    }, [props.presetOnly, presetQuery.sameScope, requestedController, catalogController, catalogPlacementAvailable, accountHostPending, accountHostUnreadable, props.presetId, props.initialOptionsSelectors, props.initialEnrollmentIdentity, provisioner, title, continuation, continuationSeed, continuationSetup, setError]);
    React.useEffect(() => {
        if (!presetQuery.sameScope || !hasOpenedManagedMachinePresetCreationV1(preset) || !provisioner || teamDenied) return;
        // A hand-off for this Preset resumes its unsaved draft at the revision that draft was based on.
        const handOff = continuation?.preset?.id === preset.id ? continuation : undefined;
        const seed = handOff?.draft.creation ?? preset;
        const initial = createManagedConfiguratorDraft({ provisioner, controller: seed.controllerPoolId ? undefined : catalogController ?? seed.controller,
            controllerPoolId: seed.controllerPoolId,
            // The editor's one name is the preset's; a Machine made from it starts with the provider's default name, as a one-off does.
            name: handOff ? handOff.draft.name : props.presetOnly ? preset.launch.name : title,
            enrollmentIdentity: props.initialEnrollmentIdentity,
            credentials: delegatedPreset && !props.presetOnly ? undefined : seed.launch.credentials, setup: handOff ? continuationSeed : preset.setup,
            preset: { id: preset.id, revision: handOff?.preset?.revision ?? preset.revision, name: preset.name, retention: seed.retention, wakeOnAcceptedMessage: seed.wakeOnAcceptedMessage } });
        setDraft(current => current ?? { ...initial, selected: { id: `preset:${preset.id}`, title: preset.name, launch: seed.launch.choices } });
        if (handOff && !continuationEntered.current) {
            continuationEntered.current = true;
            setLimit(handOff.draft.creation ? handOff.draft.creation.simultaneousLimit?.maximum : preset.simultaneousLimit?.maximum);
            if (continuationSetup?.ok === false) setError('machine_setup_conflict', 'save');
        }
    }, [presetQuery.sameScope, preset, provisioner, catalogController, teamDenied, props.initialEnrollmentIdentity, delegatedPreset, continuation, continuationSeed, continuationSetup, setError]);

    React.useEffect(() => {
        if (delegatedPreset && !props.presetOnly || !presetQuery.sameScope || !catalogProvisioner || !catalogPlacementAvailable
            || !props.presetOnly && catalogProvisioner.credentialPurposes === undefined) return;
        setDraft(current => current ? refreshManagedConfiguratorProvisioner(current, catalogProvisioner,
            props.presetOnly ? current.controller : pooledDraft ? undefined : catalogController) : current);
    }, [props.presetOnly, delegatedPreset, pooledDraft, presetQuery.sameScope, catalogProvisioner, catalogController, catalogPlacementAvailable, draft?.credentials, draft?.provisioner]);

    React.useEffect(() => {
        if (!pendingCredential || catalog.reading) return;
        const { setup, account } = pendingCredential;
        const handoff = resolveConnectedAccountPurposeSetupHandoff(setup, { ...purposeHandoff.current,
            activeHandoff: purposeHandoff.current.pendingCredential?.setup ?? null });
        const selection = handoff.ok ? managedConfiguratorCredentialSelections({ credentials: [{ purpose: setup.request.purpose, account }] }, handoff.provisioner) : [];
        if (selection.length && handoff.ok) setDraft(value => value ? setManagedConfiguratorCredentials({ ...value, provisioner: handoff.provisioner }, [
            ...(value.credentials ?? []).filter(entry => qualifiedPurposeKey(entry.purpose) !== qualifiedPurposeKey(setup.request.purpose)), ...selection,
        ]) : value);
        else setError(handoff.ok ? 'credential_unavailable' : handoff.error.code);
        setPendingCredential(null);
    }, [pendingCredential, catalog.reading, catalog.error, catalog.binding, catalogProvisioner, catalogController]);

    // Credential retirement cancels IO; a same-Account bearer refresh keeps the local setup draft.
    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding) return;
        const retirement = binding.onRetire(() => {
            retirePending(); reviewed.current = null;
        });
        return () => { retirement.dispose(); mutationAbort.current?.abort(); optionsAbort.current?.abort(); };
    }, [catalog.binding, retirePending]);

    const setupLifetime = accountSetup?.lifetime ?? pendingCredential?.setup.lifetime;
    React.useEffect(() => {
        const retirement = setupLifetime?.onRetire(() => { setAccountSetup(null); setPendingCredential(null); });
        return () => retirement?.dispose();
    }, [setupLifetime]);

    React.useEffect(() => {
        if (teamDenied) return;
        const row = presetQuery.state.value;
        if (row) {
            const creationRow = hasOpenedManagedMachinePresetCreationV1(row) ? row : undefined;
            if (creationRow && buildQualifiedPluginContributionKey(creationRow.launch.provider) !== props.provisioner) { setError('invalid_parameters'); return; }
            if (!loadedPreset.current) {
                setLimit(row.simultaneousLimit?.maximum); setTeamId(row.owner.kind === 'team' ? row.owner.teamId : '');
            }
            loadedPreset.current = row;
            setPreset(row);
            if (!creationRow) {
                setDraft(null);
                // An Add-to-Preset hand-off for this preset starts from the saved setup plus its item.
                const handOff = continuation?.preset?.id === row.id;
                const setup = handOff ? continuationSeed : row.setup;
                setSetupOnlyDraft(current => current ?? { name: row.name, ...(setup ? { setup } : {}) });
                if (handOff && !continuationEntered.current) {
                    continuationEntered.current = true;
                    if (continuationSetup?.ok === false) setError('machine_setup_conflict', 'save');
                }
                return;
            }
            setDraft(current => current?.preset?.id === row.id ? { ...current,
                preset: { ...current.preset, revision: row.revision, name: row.name } } : current);
        }
        if (presetQuery.state.error) setError(presetQuery.state.error);
    }, [presetQuery.state.value, presetQuery.state.error, props.provisioner, teamDenied, continuation, continuationSeed, continuationSetup, setError]);

    const readOptions = React.useCallback(() => {
        optionsAbort.current?.abort();
        const binding = catalog.binding;
        if (props.presetOnly || delegatedPreset || poolUnavailableAtReview || !catalogCurrent || !presetQuery.sameScope || !binding || !catalog.homeId || !catalog.client) return;
        if (accountHostPending || accountHostUnreadable || needsApp) return;
        if (!catalogProvisioner || !catalogPlacementAvailable || !credentialsReady) {
            setDraft(current => current && current.optionStatus !== 'unavailable'
                ? { ...current, optionStatus: 'unavailable', check: undefined } : current);
            return;
        }
        if (!draft || draft.provisioner !== catalogProvisioner) return;
        const abort = new AbortController();
        optionsAbort.current = abort;
        // Retry keeps the settled failure until a different answer arrives.
        if (optionsInput.kind === 'unavailable') setError(optionsInput.error);
        setDraft(current => current ? beginManagedConfiguratorRead(current,
            optionsInput.kind === 'unavailable' ? 'unavailable' : 'loading') : current);
        const credentials = requiredCredentialSelections;
        const input = { homeId: catalog.homeId, ...(controller ? { controller } : {}), contribution: catalogProvisioner.contribution, ...(credentials.length ? { credentials } : {}) };
        void readManagedConfiguration({ binding, client: catalog.client, nativeInput: input, occurrenceId: catalogProvisioner.occurrenceId,
            provisioner: catalogProvisioner.descriptor,
            ...(optionsInput.kind === 'ready' && readSelectors !== null ? { selectors: readSelectors } : {}),
            signal: abort.signal, onApprovalPending }).then(result => {
            if (result.kind === 'retired') return;
            setDraft(current => current ? settleManagedConfiguratorRead(current, result, readSelectors ?? undefined,
                optionsInput.kind === 'loading' ? 'loading' : 'unavailable') : current);
            setError(result.failure ? describeManagedNativeFailureDiagnostic(result.failure.code, result.failure.nativeCause)
                : optionsInput.kind === 'unavailable' ? optionsInput.error : null, 'read', result.failure
                    ? resolveActionExecutionFailureMessage({ ...result.failure, ok: false, errorCode: result.failure.code },
                        result.failure.code === 'controller_unavailable' ? t('managedMachines.controller.requiredUnnamed')
                            : t('managedMachines.options.unavailable')) ?? undefined : undefined);
        });
    }, [props.presetOnly, catalogCurrent, presetQuery.sameScope, catalog.binding, catalog.homeId, catalog.client, catalogProvisioner, catalogController, catalogPlacementAvailable, controller?.machineId, controller?.installationId,
        draft?.credentials, draft?.provisioner, credentialsReady, optionsInput, readSelectorKey, delegatedPreset, pooledDraft, poolUnavailableAtReview, accountHostPending, accountHostUnreadable, needsApp]);

    React.useEffect(() => { readOptions(); return () => optionsAbort.current?.abort(); }, [readOptions]);

    const effectiveDraft = React.useMemo(() => presetQuery.sameScope && draft && accountSettings.settings
        ? { ...draft, categoryPreferences: accountSettings.settings.machineRetentionDefaultsV1 } : null, [presetQuery.sameScope, draft, accountSettings.settings]);
    const projection = React.useMemo(() => effectiveDraft ? managedConfiguratorProjection(effectiveDraft) : null, [effectiveDraft]);
    const facts = React.useMemo(() => effectiveDraft ? managedConfiguratorFacts(effectiveDraft, projection) : null, [effectiveDraft, projection]);
    const presetLaunch = React.useMemo(() => props.presetOnly && presetQuery.sameScope && draft
        ? managedConfiguratorPresetLaunch(draft, fieldInput) : null, [props.presetOnly, presetQuery.sameScope, draft, fieldInput]);
    const launchRefusal = effectiveDraft?.optionStatus === 'current' ? projection?.unavailableReason : undefined;
    React.useEffect(() => { if (facts) reviewed.current = facts; }, [facts]);
    // A settings refresh may withdraw mutation authority, not what the person already reviewed.
    // A changed draft never borrows the old choice's facts, and only fresh `facts` can be submitted.
    const captured = reviewed.current;
    const receiptFacts = facts ?? (presetQuery.sameScope && catalog.binding?.isCurrent() && captured && draft?.selected
        && draft.name === captured.launch.name && pluginJsonValuesEqual(draft.controller, captured.controller)
        && pluginJsonValuesEqual(draft.credentials ?? [], captured.launch.credentials ?? [])
        && pluginJsonValuesEqual(draft.selected.launch, captured.launch.choices) ? captured : null);
    // Agents sign in as the Account's per-agent defaults on any machine; one presenter names them beside the provider accounts.
    const agentSignInTargets = useAgentSignInTargets();
    const credentialTargets = React.useMemo(() => props.presetOnly ? [] : [
        ...(credentialPurposes ?? []).flatMap(({ options }) => options.flatMap(({ value }) => 'accountId' in value ? [{
            key: `credential-choice:${actionInputOptionValueKey(value)}`,
            target: { kind: 'account' as const, account: value },
            serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(connectedServices, value.service, t, localizeServiceText),
        }] : [])),
        ...agentSignInTargets,
        ...(receiptFacts ? managedCredentialReceiptTargets(receiptFacts.launch) : []),
    ], [props.presetOnly, credentialPurposes, connectedServices, localizeServiceText, receiptFacts?.launch, agentSignInTargets]);
    const credentialAccounts = useQualifiedConnectedAccountTargetPresentations({ binding: catalog.binding, targets: credentialTargets });
    const credentialPresentations = React.useMemo(() => managedCredentialPresentations({ credentialPurposes,
        credentials: receiptFacts?.launch.credentials, personal: credentialAccounts.presentationsByKey }),
    [credentialAccounts.presentationsByKey, credentialPurposes, receiptFacts?.launch.credentials]);
    // The chooser and receipt consume the same Account names, rather than native option placeholders.
    const credentialFields = React.useMemo(() => resolveEffectiveActionInputFields({ inputHints: { fields: (credentialPurposes ?? []).flatMap(({ purpose, options }, index) => options.length === 0 ? [] : [{
        path: String(index), title: purposeAccountTitle(purpose.purpose) ?? t('managedMachines.receipt.account'), widget: 'select' as const,
        required: requiredCredentialPurposes?.some(entry => qualifiedPurposeKey(entry.purpose) === qualifiedPurposeKey(purpose)) === true,
        options: options.map(option => {
            const name = credentialPresentations[`credential-choice:${actionInputOptionValueKey(option.value)}`]!;
            return { ...option, label: name.primaryLabel, description: name.secondaryLabel };
        }),
    }]) } }, credentialInput), [credentialPurposes, requiredCredentialPurposes, credentialInput, purposeAccountTitle, credentialPresentations]);
    // Pending only until the Account's names are first read (a refresh keeps them); a failed read says Unavailable.
    const agentSignIn = props.presetOnly ? undefined : agentSignInTargets.map(entry => ({ agent: entry.agent,
        account: credentialAccounts.loading && !credentialAccounts.resolved ? null
            : credentialAccounts.presentationsByKey[entry.key]?.primaryLabel ?? null }));
    const selectedCapabilities = draft ? managedConfiguratorCapabilities(draft, projection ?? undefined) : provisioner?.descriptor;
    const billing = selectedCapabilities?.billing;
    const retentionCapabilities = selectedCapabilities?.retention;
    const defaultPolicy = billing ? resolveMachineRetentionPolicyV1({ billing,
        nativeCapabilities: retentionCapabilities, presetOverride: props.presetOnly ? undefined : draft?.preset, categoryPreferences: accountSettings.settings?.machineRetentionDefaultsV1 }) : null;
    const finiteOnly = retentionCapabilities?.finiteOnly === true;
    const nativeDurationField = finiteOnly && provisioner?.descriptor.nativeDurationInput
        ? fields.find(field => field.path === provisioner.descriptor.nativeDurationInput?.path) : undefined;
    const launchFields = fields.filter(field => field !== nativeDurationField);
    const keepPolicy = facts ?? (finiteOnly ? defaultPolicy : null);
    const nativeExpiry = retentionCapabilities?.nativeExpiry;
    const receiptController = receiptFacts?.controller ?? controller;
    const savedControllerName = receiptController && preset?.controller && preset.controller.machineId === receiptController.machineId
        && preset?.controller?.installationId === receiptController?.installationId ? preset?.controllerDisplayName : undefined;
    const liveControllerName = useServerScopedMachine(props.serverId, receiptController?.machineId,
        React.useCallback((machine: Machine | null) => machine && isMachineVisibleForSelection(machine)
            && machine.installationId === receiptController?.installationId ? getMachineDisplayName(machine) : null,
        [receiptController?.installationId]));
    const knownControllerName = liveControllerName ?? savedControllerName;
    // Sentences ("Runs on …", "How much CPU and memory … has free") never say "Unknown": an unnamed controller is the
    // computer that manages it. A delegated receipt also uses that label without reading the controller.
    // A pool-backed preset is managed by whichever connected machine in its pool takes it. Its editor names the pool;
    // a delegated review can use the shared availability without reading private pool members.
    const poolName = useMachinePoolName(props.serverId, props.presetOnly && pooledDraft ? draft?.controllerPoolId || null : null);
    const controllerName = pooledDraft ? poolName ?? t('machinePresets.controllerPoolAny') : knownControllerName ?? t('managedMachines.receipt.managingComputer');
    const controllerSentence = !pooledDraft ? controllerName : poolName ? t('machinePresets.controllerPoolIn', { pool: poolName })
        : t('machinePresets.controllerPoolInUnnamed');
    const activeBinding = catalog.binding;
    const setupProjection = !props.presetOnly && draft?.preset && draft.setup && activeBinding
        ? readCurrentAppShellPluginUiProjection({ scope: activeBinding.scope, declarationsOnly: true }) : null;
    const setupInputsValid = props.presetOnly || !draft?.preset || !draft.setup
        || readMachineSetupRecipeInputState(draft.setup, setupProjection).valid;
    const editSetupInputs = () => {
        if (draft?.preset) router.push(`/settings/machines/presets/${encodeURIComponent(draft.preset.id)}?serverId=${encodeURIComponent(props.serverId)}&edit=true` as never);
    };
    // The options query accepts partial hardware; the launch declaration names what Create still needs.
    const requiredLaunchPaths = new Set(deriveActionInputHints(provisioner?.descriptor.launchSchema, undefined)?.fields
        ?.filter(field => field.required).map(field => field.path));
    const missingLaunchField = launchFields.find(field => (field.required || requiredLaunchPaths.has(field.path))
        && isBlankInput(readInputPath(fieldInput, field.path)));
    const missingDimension = draft ? managedConfiguratorMissingDimension(draft, projection) : undefined;
    // One decision owns both admission of the Create control and the reason beside it.
    const creationUnavailableReason = busy ? t('common.loading')
        : !activeBinding?.isCurrent() ? t('common.unavailable')
        // Delegated review consumes its saved facts; authoring consumes the current options scope.
        : (!delegatedPreset && !catalogCurrent) || !catalogProvisioner ? t('managedMachines.providers.unavailable')
        : needsApp ? t('managedMachines.add.status.needsApp')
        : accountHostUnreadable ? t('common.unavailable')
        : accountHostPending ? t('managedMachines.options.loading', { provider: title })
        : (!catalogPlacementAvailable || (teamId || preset?.owner.kind === 'team') && !pooledDraft && !catalogController) && !delegatedPreset ? t('managedMachines.controller.requiredUnnamed')
        : poolUnavailableAtReview ? t('machinePresets.poolNoMachine')
        : !credentialsReady ? t('managedMachines.credential.choose')
        : hostAvailability?.requiresController ? t('managedMachines.controller.requiredUnnamed')
        : !props.presetOnly && accountSettings.settings?.managedMachineCreationEnabled === false ? t('managedMachines.creation.disabledTitle')
        : !accountSettings.settings || !props.presetOnly && accountSettings.settings.managedMachineCreationEnabled !== true ? t(accountSettings.error ? 'common.unavailable' : 'common.loading')
        : draft?.check?.available === false ? draft.check.status
            ? localized(catalogProvisioner.contribution.pluginId, draft.check.status) : t('managedMachines.providers.unavailable')
        : draft?.check?.available !== true ? t('managedMachines.options.loading', { provider: title })
        : launchRefusal ? localized(catalogProvisioner.contribution.pluginId, launchRefusal.status)
        : error?.during === 'read' && error.reason ? error.reason
        : !facts ? missingLaunchField ? t('session.actionsDraft.validation.requiredField', { field: missingLaunchField.title })
            : missingDimension ? t('session.actionsDraft.validation.requiredField', {
                field: missingDimension === 'duration' ? t('managedRetention.ends') : t(`managedMachines.config.${missingDimension}`),
            })
            : draft?.optionStatus === 'loading' || launchPresentationPending ? t('managedMachines.options.loading', { provider: title })
                : t('managedMachines.options.unavailable')
        : facts.optionStatus !== 'current' ? t(facts.optionStatus === 'loading' ? 'common.loading' : 'managedMachines.options.unavailable')
        : !isManagedEnrollmentIdentityReviewed(draft?.enrollmentIdentity) ? t('managedMachines.identity.administratorInvalid')
        : preset?.archivedAt !== undefined ? t('machinePresets.archived')
        : !setupInputsValid ? t('managedMachines.creationReview.inputsHelp') : null;
    const mayCreate = creationUnavailableReason === null;
    // A retained launch can still be saved, but explicit field edits must satisfy the declared input schema.
    const saveLaunch = props.presetOnly ? presetLaunch : facts?.launch;
    const saveTargetAvailable = pooledDraft ? !!draft?.controllerPoolId
        : !(teamId || preset?.owner.kind === 'team') || !!draft?.controller;
    const maySave = !!saveLaunch && saveTargetAvailable
        && (props.presetOnly ? catalogCurrent : draft?.optionsSelectorsEdited !== true && (draft?.optionsSelectors === undefined || selectors !== null))
        && !!activeBinding?.isCurrent() && teamWritable && !busy;
    // Why Save is off, in the words Create uses; only who may write the Preset is Save's alone.
    const authoringUnavailableReason = !props.presetOnly ? null : busy ? t('common.loading')
        : !activeBinding?.isCurrent() || !catalogCurrent ? t('common.unavailable')
        : !saveTargetAvailable ? t('managedMachines.controller.requiredUnnamed')
        : missingLaunchField ? t('session.actionsDraft.validation.requiredField', { field: missingLaunchField.title })
        : !presetLaunch ? t('managedMachines.options.unavailable') : null;
    const saveUnavailableReason = maySave ? null : (props.presetOnly ? authoringUnavailableReason : creationUnavailableReason) ?? (teamWritable ? t('managedMachines.options.unavailable')
        : team.kind === 'bound' && team.state.kind === 'ready' ? t('machinePresets.memberCreateManagersOnly', { team: team.state.team.name })
        : t(team.kind === 'bound' && team.state.kind === 'unavailable' ? 'common.unavailable' : 'common.loading'));
    const presetRetention = draft?.override?.retention ?? draft?.preset?.retention;
    // A preset is reusable; this creation's absolute deadline remains only in its one-off draft.
    const reusablePresetRetention = presetRetention?.kind === 'deadline' ? undefined : presetRetention;
    const completedSave = (value: PresetMutationResultV1) => {
        if (!activeBinding?.isCurrent()) return;
        setBusy(false);
        if (value.kind === 'saved' && continuation) { setError(null); continuation.onReturn(); }
        else if (value.kind === 'saved') { setSaved({ id: value.preset.id, name: value.preset.name, serverId: activeBinding.serverId }); setError(null); if (props.presetOnly && props.onPresetSaved) props.onPresetSaved({ serverId: activeBinding.serverId, id: value.preset.id, name: value.preset.name }); else if (props.presetOnly) router.replace(`/settings/machines/presets/${encodeURIComponent(value.preset.id)}?serverId=${encodeURIComponent(activeBinding.serverId)}` as never); }
        else if (value.kind === 'refused' && props.presetId && isMachinePresetAccessLost(value.code)) presetQuery.withdraw(value.code);
        else setError(value.kind === 'conflict' ? 'conflict' : value.code, 'save');
    };
    const failed = (code: string, during: 'read' | 'create' | 'save', diagnosticDetail?: string, failure?: ManagedProvisionerFailure) => { if (activeBinding?.isCurrent()) {
        if (props.presetId && isMachinePresetAccessLost(code)) presetQuery.withdraw(code);
        else { setBusy(false); setError(code, during, failure
            ? resolveActionExecutionFailureMessage({ ...failure, ok: false, errorCode: code }, '') || undefined
            : undefined, diagnosticDetail); }
    } };
    const repair = async (action: NonNullable<ManagedPrerequisiteV1['repairAction']>) => {
        if (!catalogCurrent || !activeBinding?.isCurrent() || !catalogController && !accountAcquire || !catalogProvisioner || busy) return;
        const abort = new AbortController(); mutationAbort.current = abort;
        setBusy(true); setError(null); setRepairFailure(null);
        try {
            const outcome = await presentation.repair(action, activeBinding, abort.signal);
            if (abort.signal.aborted || !activeBinding.isCurrent()) return;
            setBusy(false);
            if (outcome.ok) retry(); else setRepairFailure({ binding: activeBinding, controller: catalogController,
                provisioner: props.provisioner, outcome });
        } catch { if (!abort.signal.aborted && activeBinding.isCurrent()) {
            setBusy(false);
            setRepairFailure({ binding: activeBinding, controller: catalogController, provisioner: props.provisioner,
                outcome: createPluginSurfaceActionFailure('unavailable', 'unavailable') });
        } }
    };
    const save = async () => {
        if (!saveLaunch || !catalog.homeId || !activeBinding?.isCurrent() || !presetClient || !maySave) return;
        const saveDraft: MachinePresetEditDraft = { name: saveLaunch.name, setup: draft?.setup,
            creation: { launch: saveLaunch, ...(draft?.controllerPoolId ? { controllerPoolId: draft.controllerPoolId }
                : { controller: props.presetOnly ? draft?.controller : facts?.controller }),
                ...(reusablePresetRetention ? { retention: reusablePresetRetention } : {}),
                ...((draft?.override?.wakeOnAcceptedMessage ?? draft?.preset?.wakeOnAcceptedMessage) !== undefined
                    ? { wakeOnAcceptedMessage: draft?.override?.wakeOnAcceptedMessage ?? draft?.preset?.wakeOnAcceptedMessage } : {}),
                ...(limit ? { simultaneousLimit: { maximum: limit } } : {}) } };
        await submitDraft(saveDraft);
    };
    // The one Save: the edited draft goes to the existing Preset CRUD owner (update of this preset, or a new one).
    const submitDraft = async (saveDraft: MachinePresetEditDraft) => {
        if (!catalog.homeId || !activeBinding?.isCurrent() || !presetClient) return;
        setBusy(true); setError(null);
        const abort = new AbortController(); mutationAbort.current = abort;
        const callbacks = { signal: abort.signal, onApprovalPending, onApprovalSucceeded: completedSave, onApprovalFailed: (code: string) => failed(code, 'save') };
        try {
        const result = await presetClient.saveDraft({ draft: saveDraft, ...(props.presetOnly && preset ? {
            preset: { ...preset, id: preset.id,
                revision: continuation?.preset?.id === preset.id ? draft?.preset?.revision ?? preset.revision : preset.revision },
        } : { id: randomUUID(), owner: teamId ? { kind: 'team' as const, teamId }
            : { kind: 'account' as const, accountId: activeBinding.accountId } }) }, callbacks);
        if (!abort.signal.aborted) { if (result.kind === 'succeeded') completedSave(result.value); else if (result.kind === 'failed') failed(result.code, 'save', result.diagnosticDetail); }
        } catch { if (!abort.signal.aborted) failed('unavailable', 'save'); }
    };
    const maySaveSetupOnly = !!setupOnlyDraft && !!preset && preset.archivedAt === undefined && !!presetClient
        && teamWritable && !!activeBinding?.isCurrent() && !busy;
    const completeCreation = (managedId: string) => {
        if (!activeBinding?.isCurrent()) return;
        if (props.onCreated) props.onCreated({ serverId: activeBinding.serverId, managedId });
        else router.replace(`/settings/machines/managed/${encodeURIComponent(managedId)}?serverId=${encodeURIComponent(activeBinding.serverId)}` as never);
    };
    const continueCreation = async (selected: ManagedMachineSelectionDraft,
        value: ManagedMachineActionOutputV1<'machines.managed.acquire'>, abort: AbortController) => {
        if (!activeBinding?.isCurrent() || abort.signal.aborted) return;
        if (value.operation) {
            // The admitted continuation belongs to the Account, beyond this page's visibility or lifetime.
            const lifetime = readServerAccountScopeOwnerLifetime(activeBinding);
            if (mutationAbort.current === abort) mutationAbort.current = null;
            const retirement = lifetime.onRetire(() => abort.abort());
            try {
                await runManagedMachineCreation({ draft: selected,
                    acquisition: { requestId: randomUUID(), selection: selected.selection, managedId: value.managedId, operation: value.operation },
                    scope: { serverId: activeBinding.serverId, accountId: activeBinding.accountId },
                    signal: abort.signal, isCurrent: () => lifetime.isCurrent(), onApprovalPending,
                    onAcquisitionChange: () => {}, onProgress: progress => {
                        if (progress.kind === 'failed' && activeBinding.isCurrent()) failed(progress.code, 'create', progress.diagnosticDetail);
                    } });
            } finally { retirement.dispose(); }
        }
        if (!abort.signal.aborted) completeCreation(value.managedId);
    };
    // A correlated waiting admission opens its managed row; it is not a completed native Action.
    const admitted = (receipt: ExternalActionManagedAdmissionReceiptV1) => completeCreation(receipt.managedId);
    const reviewedAcquireInput = async () => {
        if (!effectiveDraft || !facts || !catalog.homeId || !mayCreate || !activeBinding?.isCurrent() || !catalog.client) return;
        const acquireDraft = creationPreset
            ? resolveManagedConfiguratorAcquireDraft(effectiveDraft, creationPreset.launch, facts.launch) : effectiveDraft;
        if (acquireDraft.preset) {
            if (!creationPreset || !presetClient || !effectiveDraft.enrollmentIdentity) return;
            try {
                const prepared = await presetClient.prepareAcquireOverride(creationPreset, {
                    enrollmentIdentity: effectiveDraft.enrollmentIdentity, launchName: effectiveDraft.name });
                if (!activeBinding.isCurrent()) return;
                if (prepared.kind !== 'ready') { failed(prepared.code, 'create'); return; }
                return managedConfiguratorAcquireInput(acquireDraft, catalog.homeId, prepared.override);
            } catch { if (activeBinding.isCurrent()) failed('unavailable', 'create'); return; }
        }
        return managedConfiguratorAcquireInput(acquireDraft, catalog.homeId);
    };
    const reviewedSelection = (input: ManagedAcquireInputV1) => {
        if (!facts) return null;
        return createManagedMachineSelectionDraft({ selection: input.selection,
            receipt: 'reviewedFacts' in input && input.reviewedFacts ? input.reviewedFacts : facts,
            enrollmentIdentity: effectiveDraft?.enrollmentIdentity,
            ...(input.selection.kind === 'preset' && creationPreset ? {
                ...('presetContentOverride' in input && input.presetContentOverride ? { presetContentOverride: input.presetContentOverride } : {}),
                presetOrigin: { id: creationPreset.id, homeId: creationPreset.homeId, revision: creationPreset.revision,
                    controller: creationPreset.controller, controllerPoolId: creationPreset.controllerPoolId,
                    retention: creationPreset.retention, wakeOnAcceptedMessage: creationPreset.wakeOnAcceptedMessage } } : {}) });
    };
    const commitUse = async () => {
        const input = await reviewedAcquireInput();
        const selected = input && reviewedSelection(input);
        if (!selected || !activeBinding?.isCurrent()) return;
        if (props.createOnUse) props.onUse?.(selected, { create: true });
        else if (props.startsSession) props.onUse?.(selected, { send: true });
        else props.onUse?.(selected);
    };
    const create = async () => {
        const input = await reviewedAcquireInput();
        if (!input || !activeBinding?.isCurrent() || !catalog.client) return;
        setBusy(true); setError(null);
        const abort = new AbortController(); mutationAbort.current = abort;
        const selected = reviewedSelection(input);
        if (!selected) return;
        const created = (value: ManagedMachineActionOutputV1<'machines.managed.acquire'>) => continueCreation(selected, value, abort);
        try {
        const result = await catalog.client.execute('machines.managed.acquire', input, { signal: abort.signal,
            ...(input.selection.kind === 'preset' && creationPreset ? { managedPresetOrigin: creationPreset } : {}),
            onApprovalPending, onApprovalSucceeded: created, onApprovalAdmitted: admitted,
            onApprovalFailed: (code, failure) => failed(code, 'create', describeManagedActionFailureDiagnostic(code, failure?.details, failure?.requestId, failure?.failureCause), projectManagedProvisionerFailure(code, failure?.details, failure?.requestId, failure?.failureCause)) });
        if (!abort.signal.aborted) { if (result.kind === 'succeeded') await created(result.value); else if (result.kind === 'admitted') admitted(result.receipt); else if (result.kind === 'failed')
            failed(result.code, 'create', describeManagedActionFailureDiagnostic(result.code, result.details, result.requestId, result.failureCause), result); }
        } catch { if (!abort.signal.aborted) failed('unavailable', 'create'); }
    };
    const rename = async () => {
        if (!draft || !activeBinding?.isCurrent()) return;
        const name = await Modal.prompt(t('managedMachines.receipt.rename'), undefined, { defaultValue: draft.name });
        if (name?.trim() && activeBinding.isCurrent()) setDraft(current => current ? { ...current, name: name.trim() } : current);
    };
    const billedAccount = credentialPresentations['credential:0']?.primaryLabel;
    // A local machine's receipt already says where it runs and that nobody bills it.
    const billingFootnote = billing?.location === 'cloud' && billedAccount
        ? t('managedMachines.receipt.cloudFootnote', { provider: title, account: billedAccount }) : null;
    // A hand-off into the editor goes back the way it came; leaving writes nothing.
    const cancelContinuation = continuation?.onReturn ?? props.onCancel;
    const continuationCancel: ManagedReceiptModel['secondary'] = cancelContinuation ? [{ label: t('common.cancel'), onPress: cancelContinuation,
        disabled: busy, testID: 'managed-config.continuation-cancel', tone: 'text' }] : undefined;
    // A Preset with setup changes the new Machine: the receipt's Create opens one review of what it does, and that review's confirm is the Create.
    const reviewsSetup = !props.presetOnly && !!draft?.preset && describeMachineSetup(draft.setup).length > 0;
    const openCreationReview = () => {
        if (!draft?.preset || !draft.setup) return;
        const identity = draft.enrollmentIdentity;
        const cost = receipt.cost && receipt.cost.kind !== 'unpriced' ? presentManagedCost(receipt.cost) : null;
        showManagedCreationReview({ name: draft.name, setup: draft.setup, scope: activeBinding?.scope ?? null,
            projection: setupProjection, onEditSetup: editSetupInputs,
            preset: { name: draft.preset.name ?? title, revision: draft.preset.revision },
            server: { title, spec: [summarySpec, cost ? `${cost.value}${cost.unit}` : null].filter(Boolean).join(' · '), mark: receiptMark },
            administrator: identity?.kind === 'dedicatedDaemonUser' ? t(`managedMachines.identity.${identity.adminAccessAtCreation}`) : undefined,
            confirmLabel: [t('managedMachines.creationReview.confirm'), cost ? `${cost.value}${cost.unit}` : null].filter(Boolean).join(' · '),
            onConfirm: () => { if (props.onUse) void commitUse(); else void create(); } });
    };
    // A preset describes every machine made from it, not one about to exist.
    const receiptCaption = props.presetOnly ? t('machinePresets.receiptCaption') : undefined;
    const receipt: ManagedReceiptModel = {
        ...(receiptFacts ? buildManagedConfigurationReceipt({ caption: receiptCaption, launch: receiptFacts.launch, reviewedFacts: receiptFacts, providerTitle: title, controllerName: delegatedPreset || pooledDraft ? controllerName : knownControllerName, homeName, mark: receiptMark, localized,
            ...(draft?.preset && presentation.descriptor ? { savedLaunchPresentation: {
                schema: presentation.descriptor.launchSchema, inputHints: optionPresentation.hints } } : {}),
            ...(pooledDraft ? { pooledController: { sentenceName: controllerSentence } } : {}),
            ...(acquireTarget === 'account' && !receiptController ? { managedBy: 'account' as const } : {}), agentSignIn,
            credentialPresentations, keepEditedBelow: Boolean(keepPolicy && defaultPolicy),
            enrollmentIdentity: props.presetOnly ? undefined : draft?.enrollmentIdentity })
            // Before choices exist the receipt still tells the truth: a local VM bills nobody, and an unnamed draft
            // names its kind under the provider rather than repeating the provider twice.
            : creationPreset && presentation.descriptor ? buildManagedConfigurationReceipt({
                caption: receiptCaption, launch: creationPreset.launch, providerTitle: title, declaredBilling: presentation.billing,
                savedLaunchPresentation: presentation.savedLaunchPresentation,
                controllerName, homeName, mark: receiptMark, localized, preset: { id: creationPreset.id, revision: creationPreset.revision, name: creationPreset.name },
            })
            : { caption: receiptCaption ?? t('managedMachines.receipt.yourNewMachine'), mark: receiptMark, name: draft?.name ?? title,
                spec: (draft?.name ?? title) === title ? presentation.kindTitle ?? '' : title, facts: managedAgentSignInReceiptFacts(agentSignIn),
                cost: billing?.location === 'local' && (pooledDraft || knownControllerName)
                    ? { kind: 'local' as const, computer: pooledDraft ? controllerSentence : knownControllerName!, meters: [] }
                    : { kind: 'unpriced' as const, provider: title } }),
        onRename: () => { void rename(); },
        keep: keepPolicy && defaultPolicy ? { policy: keepPolicy, defaultPolicy, inherited: !draft?.override && (!props.presetOnly || !draft?.preset?.retention && draft?.preset?.wakeOnAcceptedMessage === undefined),
            finiteOnly, deadline: !props.presetOnly,
            ...(finiteOnly && draft && provisioner ? { nativeDuration: {
                value: managedConfiguratorDimensionSelection(draft).duration ?? draft.selected?.nativeFacts?.duration?.id ?? null,
                choices: managedConfiguratorDimensionChoices(draft, 'duration').flatMap(({ choice, selectable }) => {
                    const duration = choice.nativeFacts?.duration;
                    return duration ? [{ id: choice.id, title: localized(provisioner.contribution.pluginId, choice.title),
                        unavailableReason: !selectable || busy || !!preset && !props.presetOnly ? t('managedMachines.options.unavailable') : undefined }] : [];
                }),
                onChange: id => setDraft(current => current ? selectManagedConfiguratorDimension(current, 'duration', id, optionsInput.kind === 'ready' ? optionsInput.schema : undefined) : current),
                ...(provisioner.descriptor.nativeDurationInput ? { editor: nativeDurationField ? <ActionInputFields fields={[nativeDurationField]} input={fieldInput}
                    editable={!!catalogProvisioner && catalogPlacementAvailable && !busy && (!preset || props.presetOnly === true)}
                    busy={busy} resolveFieldOptions={fieldOptions.resolveOptions} resolveFieldTestID={field => `managed-config.field:${field.path}`}
                    onPatch={patch => setDraft(current => current ? setManagedConfiguratorOptionsSelectors(current, { ...fieldInput, ...patch }) : current)} />
                    : <SurfaceStateCard kind="unavailable" size="line" title={t('managedMachines.options.unavailable')} /> } : {}),
            } } : {}),
            ...(nativeExpiry ? { nativeExpiry: t('managedRetention.nativeExpiry', { provider: title,
                time: nativeExpiry.kind === 'deadline' ? formatAsOfTime(nativeExpiry.at) : formatRetentionDuration(nativeExpiry.afterMs) }) } : {}),
            effects: retentionCapabilities && supportedMachineRetentionEffectsV1(retentionCapabilities.supportedIntents),
            canWake: retentionCapabilities !== undefined && isMachineRetainedWakeEligibleV1(keepPolicy.retention, retentionCapabilities),
            costs: describeKeepCosts(receiptFacts?.prices),
            consequence: retention => describeRetentionConsequence(retention, { ...(receiptFacts?.billing ?? billing ?? { location: 'unknown', stoppedBilling: 'unknown' }), provider: title }),
            onChange: policy => setDraft(current => current ? { ...current, override: policy } : current),
            onReset: () => setDraft(current => current ? { ...current, override: undefined,
                preset: props.presetOnly && current.preset ? { id: current.preset.id, revision: current.preset.revision, name: current.preset.name } : current.preset } : current), disabled: !catalogPlacementAvailable || !catalogProvisioner || busy } : undefined,
        primary: { label: reviewsSetup ? t('managedMachines.receipt.reviewAndCreate') : props.presetOnly ? t('common.save') : props.onUse && !props.createOnUse ? props.startsSession ? t('managedMachines.receipt.createAndStart') : t('common.use') : provisioner?.descriptor.kindTitle
            ? t('managedMachines.receipt.createKind', { kind: localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) }) : t('managedMachines.add.create'),
            onPress: () => { if (props.presetOnly) void save(); else if (reviewsSetup) openCreationReview(); else if (props.onUse) void commitUse(); else void create(); },
            disabled: props.presetOnly ? !maySave : !mayCreate, loading: busy, testID: props.onUse && !props.createOnUse && !props.presetOnly ? 'managed-config.use' : 'managed-config.create',
            // Why the action is off, or who bills, under the action that starts the billing.
            ...(props.presetOnly ? saveUnavailableReason ? { footnote: saveUnavailableReason } : {}
                : creationUnavailableReason ?? billingFootnote ? { footnote: creationUnavailableReason ?? billingFootnote! } : {}) },
        secondary: !props.presetOnly ? [...(continuationCancel ?? []), { label: t('managedMachines.receipt.saveAsPreset'), onPress: () => { void save(); }, disabled: !maySave, testID: 'managed-config.save-preset', tone: 'text' }]
            : continuationCancel,
        secondaryNote: !props.presetOnly && presetRetention?.kind === 'deadline' ? t('machinePresets.deadlineOmitted') : undefined,
    };

    const creationDisabledNotice = accountSettings.settings?.managedMachineCreationEnabled === false && !props.presetOnly
        ? <ManagedCreationDisabledBanner testID="managed-config.creation-disabled" /> : null;
    const summaryPrice = receipt.cost?.kind === 'price' ? receipt.cost.prices[0] : undefined;
    const selectedTitle = draft?.selected ? localized(provisioner?.contribution.pluginId ?? '', draft.selected.title) : title;
    const summaryLabel = summaryPrice?.label ? localized(provisioner?.contribution.pluginId ?? '', summaryPrice.label) : null;
    // The bar names the rate it shows, then the same size, place and Keep facts as the receipt.
    const summaryFacts = receiptFacts ? describeManagedConfigurationSummary(receiptFacts,
        value => localized(receiptFacts.launch.provider.pluginId, value)) : null;
    // A preset's selected title is its own name, which the receipt already shows as the machine's: never the spec.
    const summarySpec = [summaryLabel, summaryFacts ?? (draft?.preset ? null : selectedTitle)].filter(Boolean).join(' · ');
    if (props.presetId && (teamDenied || presetQuery.state.error && isMachinePresetAccessLost(presetQuery.state.error)))
        return <SurfaceStateCard kind="denied" title={t('machinePresets.accessLost')} testID="managed-config.error"
            action={{ label: t('managedMachines.actions.tryAgain'), onPress: retry }} />;
    // Before the provisioner is known the page keeps its own header (and with it the one way back), so the
    // state reads as this page's state rather than a loose section under the host's floating Back.
    // A saved preset must load before its provisioner catalog is enabled; that disabled catalog is not a refusal.
    const loadingCatalog = !!props.presetId && presetQuery.state.loading || catalog.loading || controllerAwaitsMachineList;
    // One failure line for the page, shared by the setup-only and creation forms.
    const errorNotice = error && !(poolUnavailableAtReview && error.during === 'read') ? <ItemGroup>
        {/* A read retries its read; a refused Create or Save is retried from the receipt's own action, which stays in view. */}
        <SurfaceStateCard kind="error" size="line" title={error.reason ?? (error.code === 'conflict' ? t('machinePresets.conflict')
            : error.code === 'machine_setup_conflict' ? t('machinePresets.setup.itemConflict')
            : error.during === 'create' ? resolveSystemTaskFailureMessage({ code: error.code, message: null }) ?? t('managedMachines.options.createFailed')
            : error.during === 'save' ? t('managedMachines.options.saveFailed') : t('managedMachines.options.error'))}
            diagnosticCode={error.code === 'conflict' || error.code === 'machine_setup_conflict' ? undefined : error.code} diagnosticDetail={error.diagnosticDetail} testID="managed-config.error"
            {...(error.code === 'conflict' || error.during === 'read' ? { action: { label: t(error.code === 'conflict' ? 'managedMachines.actions.review'
                : 'managedMachines.actions.tryAgain'), onPress: error.code === 'conflict' ? presetQuery.refresh : retry } } : {})} />
    </ItemGroup> : null;
    if (delegatedPreset && creationPreset && presetQuery.sameScope) {
        const name = delegatedName ?? creationPreset.launch.name;
        const maySubmit = !busy && !!activeBinding?.isCurrent() && creationPreset.archivedAt === undefined && !presetQuery.state.error && !poolUnavailableAtReview;
        const submit = async () => {
            if (!maySubmit || !activeBinding || !presetClient || !catalog.homeId) return;
            setBusy(true); setError(null);
            const abort = new AbortController(); mutationAbort.current = abort;
            try {
                const prepared = await presetClient.prepareAcquireOverride(creationPreset, { launchName: name }, abort.signal);
                if (!activeBinding.isCurrent() || abort.signal.aborted) return;
                if (prepared.kind !== 'ready') { failed(prepared.code, 'create'); return; }
                const selected = createManagedMachineSelectionDraft({ deferredAuthorPreset: true,
                    selection: { kind: 'preset', homeId: catalog.homeId, id: creationPreset.id, revision: creationPreset.revision },
                    presetContentOverride: prepared.override,
                    presetOrigin: { id: creationPreset.id, homeId: catalog.homeId, revision: creationPreset.revision, name,
                        controller: creationPreset.controller, controllerPoolId: creationPreset.controllerPoolId,
                        retention: creationPreset.retention, wakeOnAcceptedMessage: creationPreset.wakeOnAcceptedMessage } });
                if (props.onUse) {
                    if (props.createOnUse) props.onUse(selected, { create: true });
                    else if (props.startsSession) props.onUse(selected, { send: true });
                    else props.onUse(selected);
                } else {
                    const created = (value: ManagedMachineActionOutputV1<'machines.managed.acquire'>) => continueCreation(selected, value, abort);
                    const input = buildManagedMachineAcquireInput(selected);
                    if (!input) return;
                    const result = await catalog.client?.execute('machines.managed.acquire', input, { signal: abort.signal,
                        onApprovalPending, managedPresetOrigin: selected.presetOrigin, onApprovalSucceeded: created, onApprovalAdmitted: admitted,
                        onApprovalFailed: (code, failure) => failed(code, 'create', describeManagedActionFailureDiagnostic(code, failure?.details, failure?.requestId, failure?.failureCause), projectManagedProvisionerFailure(code, failure?.details, failure?.requestId, failure?.failureCause)) });
                    if (result?.kind === 'succeeded') await created(result.value);
                    else if (result?.kind === 'admitted') admitted(result.receipt);
                    else if (result?.kind === 'failed') failed(result.code, 'create', describeManagedActionFailureDiagnostic(result.code, result.details, result.requestId, result.failureCause), result);
                }
            } catch { if (!abort.signal.aborted) failed('unavailable', 'create'); }
            finally { if (!abort.signal.aborted && activeBinding.isCurrent()) setBusy(false); }
        };
        const delegatedReceipt: ManagedReceiptModel = {
            ...buildManagedConfigurationReceipt({ launch: { ...creationPreset.launch, name }, providerTitle: title,
                controllerName: creationPreset.controllerDisplayName ?? controllerName, homeName, mark: receiptMark, localized,
                declaredBilling: presentation.billing,
                savedLaunchPresentation: presentation.savedLaunchPresentation,
                ...(pooledDraft ? { pooledController: { sentenceName: controllerSentence } } : {}),
                preset: { id: creationPreset.id, revision: creationPreset.revision, name: creationPreset.name } }),
            ...(creationPreset.setup ? { setup: creationPreset.setup } : {}),
            onRename: () => { void Modal.prompt(t('managedMachines.receipt.rename'), undefined, { defaultValue: name })
                .then(value => { if (value?.trim() && activeBinding?.isCurrent()) setDelegatedName(value.trim()); }); },
            primary: { label: props.onUse && !props.createOnUse ? t('common.use') : t('managedMachines.add.create'),
                onPress: () => {
                    if (creationPreset.setup && describeMachineSetup(creationPreset.setup).length > 0) {
                        showManagedCreationReview({ name, setup: creationPreset.setup, scope: activeBinding?.scope ?? null,
                            projection: setupProjection, onEditSetup: () => router.push(`/settings/machines/presets/${encodeURIComponent(creationPreset.id)}?serverId=${encodeURIComponent(props.serverId)}&edit=true` as never),
                            preset: { name: creationPreset.name, revision: creationPreset.revision },
                            server: { title, spec: creationPreset.name, mark: receiptMark },
                            confirmLabel: t('managedMachines.creationReview.confirm'), onConfirm: () => { void submit(); } });
                    } else void submit();
                }, disabled: !maySubmit, ...(poolUnavailableAtReview ? { footnote: t('machinePresets.poolNoMachine') } : {}),
                loading: busy, testID: props.onUse && !props.createOnUse ? 'managed-config.use' : 'managed-config.create' },
        };
        return <ManagedMachineConfigurator title={title} mark={receiptMark} compact={compact} testID="managed-config" receiptIsBody
            receipt={delegatedReceipt} summary={{ value: '', unit: '', spec: creationPreset.name }}>
            {errorNotice}
        </ManagedMachineConfigurator>;
    }
    if (setupOnlyEdit) {
        // What it sets up and its name; it never reads a provider catalog, and Save keeps it setup-only.
        const renameSetupOnly = async () => {
            if (!setupOnlyDraft || !activeBinding?.isCurrent()) return;
            const name = await Modal.prompt(t('managedMachines.receipt.rename'), undefined, { defaultValue: setupOnlyDraft.name });
            if (name?.trim() && activeBinding.isCurrent()) setSetupOnlyDraft(current => current ? { ...current, name: name.trim() } : current);
        };
        const name = setupOnlyDraft?.name ?? preset?.name ?? t('machinePresets.title');
        const setupMark = preset ? (size: number) => <ManagedPresetMark serverId={props.serverId} preset={preset} size={size} /> : () => null;
        return <ManagedMachineConfigurator title={name} description={t('machinePresets.setupOnlyEditNote')}
            mark={setupMark(MANAGED_PROVISIONER_MARK_SIZE.header)} compact={compact} testID="managed-config"
            summary={{ value: '', unit: '', spec: name }}
            receipt={{ caption: t('machinePresets.setup.title'), name, mark: setupMark(MANAGED_PROVISIONER_MARK_SIZE.receipt),
                spec: '', facts: [], cost: null, ...(setupOnlyDraft?.setup ? { setup: setupOnlyDraft.setup } : {}),
                ...(setupOnlyDraft ? { onRename: () => { void renameSetupOnly(); } } : {}),
                primary: { label: t('common.save'), testID: 'managed-config.create', loading: busy, disabled: !maySaveSetupOnly,
                    onPress: () => { if (setupOnlyDraft && maySaveSetupOnly) void submitDraft(setupOnlyDraft); } },
                secondary: continuationCancel }}>
            {approval.approvalId ? <AttentionBanner testID="managed-config.approval" title={t('approvals.title')} description={t('approvals.status.open')}
                action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
            {errorNotice}
            {setupOnlyDraft ? <MachineSetupSection testID="managed-config.setup" setup={setupOnlyDraft.setup} name={setupOnlyDraft.name}
                editable={!busy && teamWritable} scope={activeBinding?.scope ?? null}
                onChange={setup => setSetupOnlyDraft(current => current ? { ...current, setup } : current)} />
                : error ? null : <ItemGroup surface="none"><SurfaceStateCard kind="loading" size="line" title={t('machinePresets.loading')}
                    testID="managed-config.preset-loading" /></ItemGroup>}
        </ManagedMachineConfigurator>;
    }
    if (!presetQuery.sameScope || !provisioner) {
        // A read that failed names the controller it could not read and offers Retry, as Add does; on a phone the
        // header folds the chip into its overflow, so the scope leads as its own row and the way to another machine stays in view.
        const unreadableController = !loadingCatalog && catalog.error ? knownControllerName : undefined;
        // A refused delegated review (a pool with no machine, an unavailable controller) is this page's read failure too.
        const readError = presetQuery.state.error ?? catalog.error ?? (error?.during === 'read' ? error.code : undefined);
        return <ItemList pageColumn="wide">
            <PageHeader title={props.presetOnly ? t('machinePresets.title') : t('managedMachines.picker.newMachine')} actions={compact ? undefined : pageChip}
                cancelAction={cancelContinuation ? { title: t('common.cancel'), onPress: cancelContinuation, disabled: busy,
                    testID: 'managed-config.continuation-cancel' } : undefined} />
            {creationDisabledNotice}
            {compact && pageChip ? <ManagedScopeRow testID="managed-config.scope" chip={pageChip} /> : null}
            <ItemGroup surface="none">
                <SurfaceStateCard kind={loadingCatalog ? 'loading' : readError ? 'error' : 'empty'} size="line"
                    title={presetQuery.state.error && !loadingCatalog ? t('machinePresets.loadFailed')
                        : unreadableController ? t('managedMachines.add.controllerUnreadable', { controller: unreadableController })
                        : loadingCatalog ? t('managedMachines.providers.loading') : readError ? describeManagedProvisionerFailure(readError) : t('managedMachines.providers.unavailable')}
                    diagnosticCode={readError} testID="managed-config.catalog"
                    {...(readError && !loadingCatalog ? { action: { label: t('common.retry'),
                        onPress: presetQuery.state.error ? retry : catalog.refresh } } : {})} />
            </ItemGroup>
        </ItemList>;
    }
    // A refusal the provider pins to a field the form shows is said there and as Create's reason; the launch it
    // replaced is not drawn again as a generic "no longer available" choice.
    const refusalOnField = !!launchRefusal?.fieldPath && launchFields.some(field => field.path === launchRefusal.fieldPath);
    const controllerReadUnavailable = error?.during === 'read' && error.code === 'controller_unavailable';
    const choicesBlocked = poolUnavailableAtReview || controllerReadUnavailable;
    const retainedChoice = !choicesBlocked && facts?.optionStatus === 'unavailable' && !refusalOnField ? draft?.selected : undefined;
    const repairs = (receiptFacts?.prerequisites ?? readMachineProvisionerPrerequisitesV1(draft?.check, draft?.options))
        .filter(prerequisite => prerequisite.status !== 'available' && (prerequisite.repairAction || prerequisite.status === 'unknown'));
    // Nothing to choose from yet is not "no choices" while the launch still waits on a required field: the field says what it needs.
    const awaitsRequiredInput = !!missingLaunchField;
    // A failed read leaves nothing to fill a blank required field from: the failure takes the fields' place, not a column of empty boxes.
    const readFailed = error?.during === 'read';
    // A conditional purpose needs its launch selectors before an account: choosing a native variant can waive it.
    // Mandatory-account providers still lead with Connect; native reads keep using the shared requiredness decision.
    const awaitsAccount = !draft?.preset && !!credentialPurposes?.length && !credentialsReady
        && !credentialPurposes.some(({ purpose }) => readMachineProvisionerCredentialPurposeSelectorPathsV1(
            provisioner.descriptor, purpose.purpose).length > 0);
    // A preset's launch is fixed here (only its editor changes it): its choices read as the chosen rows, not as locked fields.
    const presetLocked = !!preset && !props.presetOnly;
    // While its choices load it shows nothing the answer would then take over.
    const showLaunchFields = !choicesBlocked && launchFields.length > 0 && !awaitsAccount && !(readFailed && awaitsRequiredInput)
        && !(presetLocked && !draft?.options);
    // A free-form host (Cua, Lima) sizes itself from its form: at most one size row comes back, echoing what was asked.
    // The form is then the one Size choice; the fields that row assigns move into Size and no echo table is drawn.
    // A preset's sole size reads as that row (CPU, memory and disk in their units), like its image and place.
    const sizeAssigned = new Set(draft?.options?.dimensions.size.flatMap(row => row.assignments.map(assignment => assignment.path)) ?? []);
    // The fields that row assigns, and their siblings in the same input object (an optional disk the row only assigns
    // once given): the size is that object.
    const parentPath = (path: string) => path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null;
    const sizeObjects = new Set([...sizeAssigned].map(parentPath).filter((path): path is string => path !== null));
    const sizeFields = draft && (draft.options?.dimensions.size.length ?? 0) <= 1
        && !(presetLocked && draft.options?.dimensions.size[0]?.nativeFacts?.size)
        ? launchFields.filter(field => sizeAssigned.has(field.path)
        || sizeObjects.has(parentPath(field.path) ?? '')) : [];
    // Only a form that authors the native size replaces its choice table.
    const formSized = sizeFields.length > 0;
    // A field a choice section decides (every row of its image, place, network or size table assigns it) is that
    // section's choice: the form doesn't repeat it as a raw provider field.
    const choiceDimensions: readonly ('size' | 'image' | 'location' | 'network')[] = formSized
        ? ['image', 'location', 'network'] : ['size', 'image', 'location', 'network'];
    const choiceRows = choiceDimensions.map(dimension => draft?.options?.dimensions[dimension] ?? []);
    const formFields = launchFields.filter(field => !sizeFields.includes(field)
        && !choiceRows.some(rows => {
            if (rows.length === 0) return false;
            const values = rows.map(row => {
                const assignment = row.assignments.find(candidate => managedConfiguratorChoiceOwnsField(candidate.path, field.path));
                return assignment?.path === field.path ? assignment.value : assignment
                    ? readInputPath(assignment.value, field.path.slice(assignment.path.length + 1)) : undefined;
            });
            // A root assignment supplies only its own operands. Keep a declared variant selector when
            // its alternatives include a representation these rows cannot choose (a prepared native image).
            return values.every(value => value !== undefined) && !(field.widget === 'select'
                && field.options?.some(option => !values.some(value => pluginJsonValuesEqual(value, option.value))));
        }))
        .map(field => launchRefusal?.fieldPath === field.path
            ? { ...field, description: localized(provisioner.contribution.pluginId, launchRefusal.status) } : field);
    const launchEditable = !!catalogProvisioner && catalogPlacementAvailable && !busy && (!preset || props.presetOnly === true);
    const advancedKey = draft ? buildQualifiedPluginContributionKey(draft.provisioner.contribution) : '';
    // Decided on the provider's first answer; until then every field stays in view.
    if (draft && draft.optionStatus !== 'loading' && formFields.length > 0 && advancedPaths.current?.key !== advancedKey) {
        advancedPaths.current = { key: advancedKey, paths: new Set(formFields.filter(field => !field.required
            || !isBlankInput(readInputPath(fieldInput, field.path))).map(field => field.path)) };
    }
    const advancedSet = advancedPaths.current?.key === advancedKey ? advancedPaths.current.paths : null;
    // Only once the size is chosen elsewhere (its own form section or a size table) are the rest details; a provider
    // whose form is its only choice keeps it in view. A preset's launch reads as its chosen rows, and the editor
    // keeps every field in view.
    const sizeChosenElsewhere = sizeFields.length > 0 || (draft?.options?.dimensions.size.length ?? 0) > 1;
    // A form led by one blank required field (a container's image) asks that first: what the provider defaulted is detail.
    // A provider with several required fields, or one editing a filled-in form, keeps them in view.
    const ledByRequiredField = advancedSet !== null && formFields.filter(field => field.required && !advancedSet.has(field.path)).length === 1;
    const advancedFields = advancedSet && !presetLocked && (sizeChosenElsewhere && !props.presetOnly || ledByRequiredField)
        ? formFields.filter(field => advancedSet.has(field.path)) : [];
    const primaryFields = formFields.filter(field => !advancedFields.includes(field));
    // An error, or a required field emptied since, is never hidden in a closed disclosure.
    const advancedNeedsYou = advancedFields.some(field => field.path === launchRefusal?.fieldPath
        || field.path === missingLaunchField?.path);
    // Closed, it says what it holds: the short choices (architecture, driver), not paths.
    const advancedSummary = advancedFields.flatMap(field => {
        const value = readInputPath(fieldInput, field.path);
        const label = field.options?.find(option => option.value === value)?.label;
        return typeof label === 'string' && label ? [label] : [];
    }).join(' · ');
    // The form sits in its section's sheet with the row insets every other row there has.
    const launchForm = (fields: typeof launchFields, invalidNotice: boolean) => <>
        <SectionContentRow>
            <ActionInputFields fields={fields} input={fieldInput} editable={launchEditable}
                busy={busy} resolveFieldOptions={fieldOptions.resolveOptions} resolveFieldTestID={field => `managed-config.field:${field.path}`}
                onPatch={patch => setDraft(current => current ? setManagedConfiguratorOptionsSelectors(current, { ...fieldInput, ...patch }) : current)} />
        </SectionContentRow>
        {invalidNotice && (props.presetOnly ? presetLaunch === null : selectors === null) && !awaitsRequiredInput ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.options.unavailable')} diagnosticCode="invalid_parameters" /> : null}
    </>;
    // A failed check is the cause: its own words say why and what to do ("Not installed · get it from …"), ahead of the option
    // reads that fail because of it. The generic line only fills the gap when the check named nothing.
    const choiceState = props.presetOnly || !draft || choicesBlocked ? null
        : launchFormUnreadable ? <SurfaceStateCard kind="warning" size="line" testID="managed-config.form-unavailable"
            title={t('managedMachines.options.error')}
            action={{ label: t('common.retry'), onPress: retry, testID: 'managed-config.form-unavailable:action' }} />
        : draft.check?.available === false ? <SurfaceStateCard kind="warning" size="line" testID="managed-config.unavailable" title={t('managedMachines.providers.unavailable')}
            diagnosticCode={draft.check.nativeCause ? describeManagedNativeFailureDiagnostic(draft.check.code ?? 'provider_unavailable', draft.check.nativeCause) : undefined}
            reason={draft.check.status ? localized(provisioner.contribution.pluginId, draft.check.status) : undefined} />
        : facts?.optionStatus === 'unavailable' && !refusalOnField ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.options.unavailable')} />
        // A re-read keeps the last answer in place: only a first read shows that choices are being checked.
        // Until the launch form is known, which choices it holds is unknown too: the checking line stands for both.
        : draft.optionStatus === 'loading' && !draft.options || launchPresentationPending ? <SurfaceStateCard kind="loading" size="line" title={t('managedMachines.options.loading', { provider: title })} />
        : draft.optionStatus === 'current' && !draft.options?.base && !Object.values(draft.options?.dimensions ?? {}).some(rows => rows.length)
            // A reviewed preset fixes its choices: an empty live catalog says nothing about it.
            ? (awaitsRequiredInput || delegatedPreset ? null : <SurfaceStateCard kind="empty" size="line" title={t('managedMachines.options.empty', { provider: title })} />)
        : null;
    const kindTitle = presentation.kindTitle;
    // Copy that names a size, a place or a cost only appears where the provider offers them; a container is just what it runs.
    const hasDimensionChoices = sizeFields.length > 0 || (['size', 'location', 'network'] as const).some(dimension => (draft?.options?.dimensions[dimension].length ?? 0) > 0);
    // A preset's editor is titled with the preset's own name (lab p/editor); its mark still says which provider.
    const pageTitle = props.presetOnly ? draft?.name || title
        : !kindTitle ? title : t('managedMachines.config.newKind', { provider: title, kind: kindTitle });
    // Unpriced, the bar's value stays short; the sentence belongs to the receipt. No price yet is no value, not a placeholder.
    const summaryCost = receipt.cost && receipt.cost.kind !== 'unpriced' ? presentManagedCost(receipt.cost) : null;
    const summaryValue = summaryCost?.value ?? '';
    return <ManagedMachineConfigurator title={pageTitle} description={props.presetOnly ? t('machinePresets.futureOnly')
        // A preset fixes the launch: the page says whose choices these are instead of asking to pick them.
        : presetLocked && preset ? t('managedMachines.config.presetDescription', { preset: preset.name })
        : compact ? undefined : t(hasDimensionChoices ? 'managedMachines.config.description' : 'managedMachines.config.descriptionForm')} mark={mark}
        actions={pageChip}
        blocker={needsApp ? { kind: 'needsApp', title: t('managedMachines.add.status.needsApp'),
            reason: t('managedMachines.add.handoff.body', { provider: title }),
            action: { label: t('managedMachines.add.action.getTheApp'), onPress: () => showManagedGetTheAppModal(title) } } : undefined}
        compact={compact} testID="managed-config" receipt={receipt} sheetFooter={props.sheetFooter} summary={{ value: summaryValue,
            unit: summaryCost?.unit ?? '',
            spec: (props.presetOnly ? saveUnavailableReason : creationUnavailableReason) ?? summarySpec }}>
        {approval.approvalId ? <AttentionBanner testID="managed-config.approval" title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {creationDisabledNotice}
        {!setupInputsValid ? <SurfaceStateCard testID="managed-config.recipe-inputs" kind="warning" size="line"
            title={t('machinePresets.setup.recipeInputsInvalid')} reason={t('managedMachines.creationReview.inputsHelp')}
            action={{ label: t('machinePresets.editSetup'), onPress: editSetupInputs }} /> : null}
        {/* The reason Create is off, as the preset's own page gives it. */}
        {!props.presetOnly && preset?.archivedAt !== undefined ? <AttentionBanner testID="managed-config.preset-archived" tone="neutral" title={t('machinePresets.archived')} /> : null}
        {/* A failure leads the form column, where the choices would be: below a long page it would sit out of sight on a phone. */}
        {errorNotice}
        {props.startFromPending ? <ItemGroup surface="none"><SurfaceStateCard kind="loading" size="line" testID="managed-config.start-from-pending"
            title={t('managedMachines.options.loading', { provider: title })} /></ItemGroup> : <>
        {props.startFrom ? <ManagedStartFromSection testID="managed-config.start-from" presets={props.startFrom.presets}
            selectedId={props.presetId ?? null} disabled={busy} onChange={props.startFrom.onChange} /> : null}
        {draft && credentialPurposes?.length ? <ItemGroup title={t('managedMachines.receipt.account')}
            description={!requiredCredentialPurposes?.length ? t('common.optional') : credentialsReady ? undefined
                : t(requiredCredentialPurposes.some(({ options }) => options.length === 0) ? 'managedMachines.credential.required' : 'managedMachines.credential.choose')}>
            {/* At the rows' inset, as the launch fields are: a field flush with the sheet's edge reads as outside it. */}
            {credentialFields.length ? <SectionContentRow><ActionInputFields fields={credentialFields} input={credentialInput}
                editable={!!catalogProvisioner && catalogPlacementAvailable && !busy && (!preset || props.presetOnly === true)} busy={busy}
                resolveFieldOptions={credentialFieldOptions} resolveFieldTestID={field => `managed-config.credential:${credentialPurposes?.[Number(field.path)]?.purpose.purpose}`}
                getChipAccessibilityLabel={({ option }) => credentialPresentations[`credential-choice:${actionInputOptionValueKey(option.value)}`]?.accessibilityLabel}
                onPatch={patch => {
                    if (!catalogProvisioner || !catalogPlacementAvailable || busy || preset && !props.presetOnly) return;
                    const input = { ...credentialInput, ...patch };
                    const selections = (credentialPurposes ?? []).flatMap(({ purpose }, index) => {
                        const parsed = ConnectedAccountActionFormSelectionV1Schema.safeParse(input[String(index)]);
                        return parsed.success ? [createManagedCredentialSelectionV1(purpose, parsed.data)] : [];
                    });
                    setDraft(current => current ? setManagedConfiguratorCredentials(current,
                        managedConfiguratorCredentialSelections({ credentials: selections }, catalogProvisioner)) : current);
                }} /></SectionContentRow> : null}
            {credentialPurposes?.map(({ purpose }) => <Item key={qualifiedPurposeKey(purpose)}
                testID={`managed-config.connect:${purpose.purpose}`} title={t(credentialSelections.some(entry =>
                    'account' in entry && qualifiedPurposeKey(entry.purpose) === qualifiedPurposeKey(purpose)) ? 'connectedServices.detail.actions.reconnect' : 'managedMachines.add.action.connect')}
                subtitle={purposeAccountTitle(purpose.purpose)}
                // It opens the Connect sheet: the service's own mark, or Connect's plug while the service is not named.
                icon={purposeService(purpose.purpose) ? <ConnectedServiceMark legacyServiceId={null}
                    service={purposeService(purpose.purpose)!} size="card" /> : <Icon name="plug" />}
                disabled={!catalogPlacementAvailable || !catalogProvisioner || busy || !!preset && !props.presetOnly}
                onPress={() => { void openAccountSetup(purpose.purpose); }} />)}
        </ItemGroup> : null}
        {draft && showLaunchFields && primaryFields.length ? <ItemGroup title={t(hasDimensionChoices ? 'managedMachines.detail.launchTitle' : 'managedMachines.config.launchForm')}>
            {launchForm(primaryFields, true)}
        </ItemGroup> : null}
        {draft && (retainedChoice || choiceState || repairs.length) ? <ItemGroup title={retainedChoice ? t('managedMachines.config.otherChoices') : undefined}>
            {retainedChoice ? <Item testID="managed-config.retained-choice" mode="info" title={localized(provisioner.contribution.pluginId, retainedChoice.title)}
                subtitle={t('managedMachines.options.unavailable')} selected showChevron={false} /> : null}
            {choiceState}
            {repairFailure && repairFailure.binding === activeBinding && repairFailure.provisioner === props.provisioner
                && repairFailure.controller?.machineId === catalogController?.machineId
                && repairFailure.controller?.installationId === catalogController?.installationId
                ? <ManagedProvisionerRepairFailureNotice failure={repairFailure.outcome} testID="managed-config.repairFailure" /> : null}
            {repairs.map(prerequisite => {
                const id = typeof prerequisite.requirement.id === 'string' ? prerequisite.requirement.id
                    : buildQualifiedPluginContributionKey(prerequisite.requirement.id);
                return <Item key={`${prerequisite.requirement.kind}:${id}`}
                    testID={`managed-config.repair:${prerequisite.requirement.kind}:${id}`}
                    title={prerequisite.repairAction ? t('managedMachines.add.action.setUp') : id}
                    subtitle={prerequisite.reason ?? (prerequisite.status === 'unknown' ? t('machinePools.notVerified') : id)}
                    mode={prerequisite.repairAction ? undefined : 'info'} showChevron={!!prerequisite.repairAction}
                    disabled={!!prerequisite.repairAction && (!catalogController && !accountAcquire || !catalogProvisioner || busy)} onPress={prerequisite.repairAction ? () => { if (prerequisite.repairAction) void repair(prerequisite.repairAction); } : undefined} />;
            })}
        </ItemGroup> : null}
        {/* Drawn once the form is known: before that a form-sized host's one size echo would show and then be replaced. */}
        {draft && !props.presetOnly && !choicesBlocked && !launchPresentationPending ? <ManagedConfiguratorNativeChoices serverId={props.serverId} draft={draft} localized={localized} compact={compact} computer={controllerSentence} disabled={!catalogProvisioner || !catalogController && !accountAcquire || busy || !!preset && !props.presetOnly}
            billing={selectedCapabilities!.billing}
            incomplete={!!missingLaunchField}
            formSize={formSized ? { editor: showLaunchFields && sizeFields.length ? launchForm(sizeFields, formFields.length === 0) : undefined } : undefined}
            onChange={(dimension, id) => setDraft(current => current ? selectManagedConfiguratorDimension(current, dimension, id, optionsInput.kind === 'ready' ? optionsInput.schema : undefined) : current)} /> : null}
        {draft && showLaunchFields && advancedFields.length ? <ItemGroup header="none">
            <ExpandableItem testID="managed-config.advanced" expanded={advancedOpen || advancedNeedsYou}
                onExpandedChange={setAdvancedOpen} showDivider={false}
                header={({ headerProps }) => <Item {...(headerProps as Readonly<Record<string, unknown>>)}
                    testID="managed-config.advanced.header" title={t('managedMachines.config.advanced')} subtitle={advancedSummary || undefined} />}>
                {advancedOpen || advancedNeedsYou ? launchForm(advancedFields, primaryFields.length === 0) : null}
            </ExpandableItem>
        </ItemGroup> : null}
        {/* How Happier runs on the machine it creates: reviewed after the choices the page leads with, edited only through the draft. */}
        {draft && !props.presetOnly && draft.enrollmentIdentity ? <ManagedEnrollmentIdentitySection testID="managed-config"
            identity={draft.enrollmentIdentity} computer={controllerSentence} disabled={busy}
            declared={draft.enrollmentIdentityDefaulted ? managedConfiguratorEnrollmentDefault(draft) : undefined}
            onChange={next => setDraft(current => current ? { ...current, enrollmentIdentity: next } : current)} /> : null}
        {/* Who can use it comes right after what it is: for a Team admin it's the next decision (lab m-presets). */}
        {draft && props.presetOnly && props.presetFor !== 'isolation' ? <ItemGroup title={t('machinePresets.audience')}>
            <ManagedFieldRow testID="managed-config.audience" row={{ title: t('machinePresets.canUse'),
                choices: [{ id: '', title: t('machinePresets.ownerPersonal') },
                    ...teams.rows.filter(row => row.team.capabilities.manageSettings).map(row => ({ id: row.team.id, title: row.team.name })),
                    ...(teams.hasMore ? [{ id: MORE_TEAMS, title: t('machinePresets.moreTeams') }] : [])],
                value: teamId, disabled: !!preset || busy || teams.stale,
                onChange: id => { if (id === MORE_TEAMS) teams.loadMore(); else setTeamId(id); } }} />
        </ItemGroup> : null}
        {draft && props.presetOnly && !accountAcquire ? <ManagedPresetControllerSection serverId={props.serverId} controllerPoolId={draft.controllerPoolId}
            allowPool={pooledDraft || provisioner?.acquireExecutionTarget === 'daemon'}
            disabled={busy || !teamWritable} exactController={scope.chip} onChange={controllerPoolId => setDraft(current => current ? {
                ...current, controllerPoolId, controller: controllerPoolId === undefined ? scope.controller : undefined,
            } : current)} /> : null}
        {/* Setup belongs to a preset revision; a one-off Create never runs it, so only the preset editor offers it. */}
        {draft && props.presetOnly ? <MachineSetupSection testID="managed-config.setup" setup={draft.setup} name={draft.name}
            editable={!!catalogProvisioner && catalogPlacementAvailable && !busy} scope={activeBinding?.scope ?? null}
            onChange={setup => setDraft(current => current ? { ...current, setup } : current)} /> : null}
        {draft && props.presetOnly && catalogProvisioner?.descriptor.preparation ? <ItemGroup
            testID="managed-config.prepare" description={t('machinePresets.prepareAheadHelp')}>
            <Item testID="managed-config.prepare.row" title={t('machinePresets.prepareAhead')} showChevron={false}
                rightElement={<Switch testID="managed-config.prepare.switch" accessibilityLabel={t('machinePresets.prepareAhead')}
                    value={draft.preparation?.enabled === true} disabled={busy || !teamWritable}
                    onValueChange={enabled => setDraft(current => current ? { ...current, preparation: { ...current.preparation, enabled } } : current)} />} />
        </ItemGroup> : null}
        {draft && props.presetOnly && props.presetFor !== 'isolation' ? <ItemGroup title={t('machinePresets.runningAtOnce')} description={presentation.billing?.location === 'local' ? undefined : t('machinePresets.limitHelp')}>
            <ManagedFieldRow testID="managed-config.limit" row={managedPresetLimitRow({ limit, disabled: busy,
                onChange: next => { if (activeBinding?.isCurrent()) setLimit(next); } })} />
        </ItemGroup> : null}
        {saved && !props.presetOnly ? <SurfaceStateCard testID="managed-config.saved" kind="success" size="line" title={t('machinePresets.saved', { name: saved.name })}
            action={{ label: t('machinePresets.openPreset'), onPress: () => router.push(`/settings/machines/presets/${encodeURIComponent(saved.id)}?serverId=${encodeURIComponent(saved.serverId)}` as never) }} /> : null}
        </>}
    </ManagedMachineConfigurator>;
}

/** The labelled dimensions consume the shared selection projection through the draft owner. */
function ManagedConfiguratorNativeChoices(props: Readonly<{
    serverId: string;
    draft: ManagedConfiguratorDraft;
    billing: ManagedConfiguratorDraft['provisioner']['descriptor']['billing'];
    localized: ReturnType<typeof useManagedProvisionerPresentation>['localized'];
    compact: boolean; disabled: boolean;
    /** Pending form metadata or a blank required field is not a refusal of a native choice. */
    incomplete: boolean;
    /** The computer a local VM shares, named in its size section. */
    computer: string;
    /**
     * The host sizes itself from its own form. With an `editor` (the fields its size row assigns) that form is
     * the Size section's one control; without one the form above already holds it. Either way no echo table.
     */
    formSize?: Readonly<{ editor?: React.ReactNode }>;
    onChange: (dimension: 'size' | 'image' | 'location' | 'network', id: string) => void;
}>) {
    const { draft, billing } = props;
    const pluginId = draft.provisioner.contribution.pluginId;
    const selected = managedConfiguratorDimensionSelection(draft);
    // While a read is running, the last answer stands: a row is only gone once a settled read lacks it.
    const settled = draft.optionStatus !== 'loading';
    // A choice says why it can't be picked: never offered here (this computer can't run it, or the provider
    // doesn't offer it), or only not with the other picks. A locked choice (a preset's, or while Create runs) is
    // still the chosen one: being fixed is not being gone.
    const notHere = billing.location === 'local'
        ? t('managedMachines.options.unavailableOn', { computer: props.computer })
        : t('managedMachines.options.notOffered', { provider: props.localized(pluginId, draft.provisioner.descriptor.title) });
    const unavailable = (available: boolean, selectable: boolean, invalidLaunch: boolean | undefined,
        reason: ReturnType<typeof managedConfiguratorDimensionChoices>[number]['unavailableReason']) => {
        if (available || !settled || props.incomplete && invalidLaunch && !reason) return undefined;
        if (reason) return reason.fieldPath ? undefined : props.localized(pluginId, reason.status);
        return selectable ? t('managedMachines.options.unavailableWithChoices') : notHere;
    };
    const sizeChoices = managedConfiguratorDimensionChoices(draft, 'size');
    const sizes = sizeChoices.flatMap(({ choice, available, selectable, invalidLaunch, unavailableReason, recommendedMemoryBytes }) => {
        const size = choice.nativeFacts?.size;
        if (!size) return [];
        const hourly = choice.prices?.find(price => price.unit === 'hour');
        const monthly = choice.prices?.find(price => price.unit === 'month');
        return [{ id: choice.id, name: props.localized(pluginId, choice.title), cpu: size.cpuCores === undefined ? '' : String(size.cpuCores),
            memory: size.memoryBytes === undefined ? '' : formatManagedSizeBytes(size.memoryBytes), disk: size.diskBytes === undefined ? '' : formatManagedSizeBytes(size.diskBytes),
            spec: props.localized(pluginId, size.title), ...(hourly ? { hourly: formatProviderAmount(hourly) } : {}),
            ...(monthly ? { monthly: formatProviderAmount(monthly) } : {}),
            headroom: billing.location === 'local' ? describeLocalHeadroom(size, draft.check?.localResources) : undefined,
            warning: recommendedMemoryBytes === undefined ? undefined : t('managedMachines.config.lowMemoryWarning', {
                memory: formatManagedSizeBytes(recommendedMemoryBytes),
            }),
            unavailableReason: unavailable(available, selectable, invalidLaunch, unavailableReason), selectable: selectable && !props.disabled }];
    });
    const imageChoices = managedConfiguratorDimensionChoices(draft, 'image');
    const previews = useManagedImagePreviews({ serverId: props.serverId, controllerMachineId: draft.controller?.machineId ?? null,
        pluginId, occurrenceId: draft.provisioner.occurrenceId,
        requests: imageChoices.flatMap(({ choice }) => {
            const image = choice.nativeFacts?.image;
            return image?.preview ? [{ imageId: image.id, resource: image.preview.resource }] : [];
        }) });
    const images = imageChoices.flatMap(({ choice, available, selectable, invalidLaunch, unavailableReason }) => {
        const image = choice.nativeFacts?.image;
        const preview = image ? previews.get(image.id) : undefined;
        return image ? [{ id: choice.id, name: props.localized(pluginId, choice.title),
            ...(preview ? { preview: <ManagedImagePreview source={preview}
                accessibilityLabel={image.preview?.accessibilityLabel ? props.localized(pluginId, image.preview.accessibilityLabel) : undefined} /> } : {}),
            description: unavailable(available, selectable, invalidLaunch, unavailableReason) ?? (image.description ? props.localized(pluginId, image.description) : ''), unavailableReason: unavailable(available, selectable, invalidLaunch, unavailableReason),
            selectable: selectable && !props.disabled }] : [];
    });
    const locations = managedConfiguratorDimensionChoices(draft, 'location').flatMap(({ choice, available, selectable, invalidLaunch, unavailableReason }) => {
        const location = choice.nativeFacts?.location;
        // The country comes only from the provider's own ISO code, named in the reader's language.
        return location ? [{ id: choice.id, city: props.localized(pluginId, choice.title), countryCode: location.countryCode,
            country: countryName(location.countryCode, getPreferredLanguage()), unavailableReason: unavailable(available, selectable, invalidLaunch, unavailableReason), selectable: selectable && !props.disabled }] : [];
    });
    const networks = managedConfiguratorDimensionChoices(draft, 'network').flatMap(({ choice, available, selectable, invalidLaunch, unavailableReason }) => {
        const network = choice.nativeFacts?.network;
        return network ? [{ id: choice.id, name: props.localized(pluginId, choice.title), unavailableReason: unavailable(available, selectable, invalidLaunch, unavailableReason),
            selectable: selectable && !props.disabled }] : [];
    });
    const firstPrice = sizeChoices.flatMap(({ choice }) => choice.prices ?? [])[0];
    // The section says where the prices come from and when they bill, or, locally, whose share it is.
    const sizeDescription = billing.location === 'local' ? t('managedMachines.config.localSizeDescription', { computer: props.computer })
        // A price's `source` is the provider's evidence reference (an API URL), not a name to show.
        // Without a price the receipt already says it is unavailable and who bills: the section says only when it bills.
        : [firstPrice ? t('managedMachines.config.pricesChecked', { provider: props.localized(pluginId, draft.provisioner.descriptor.title),
            time: formatAsOfTime(firstPrice.observedAt) }) : null,
            billing.stoppedBilling === 'billed' ? t('managedMachines.config.billedWhileExists')
                : billing.stoppedBilling === 'not-billed' ? t('managedMachines.config.billedWhileRunning')
                    : t('managedRetention.consequence.stopUnknown', { provider: props.localized(pluginId, draft.provisioner.descriptor.title) })]
            .filter((part): part is string => part !== null).join(' ') || undefined;
    // The echoed size can still be refused (a value the provider can't run): its reason stays under the form.
    const formSizeRefusal = !props.disabled && sizes.length === 1 ? sizes[0]!.unavailableReason : undefined;
    const formSizeWarning = sizes.length === 1 ? sizes[0]!.warning : undefined;
    const sizeSection = props.formSize ? (props.formSize.editor ? <ItemGroup testID="managed-config.size" title={t('managedMachines.config.size')} description={sizeDescription}>
        {props.formSize.editor}
        {formSizeRefusal ? <SurfaceStateCard kind="warning" size="line" title={formSizeRefusal} testID="managed-config.size-refused" /> : null}
        {formSizeWarning ? <SurfaceStateCard kind="warning" size="line" title={formSizeWarning} testID="managed-config.size-warning" /> : null}
    </ItemGroup> : null)
        : sizes.length ? <ItemGroup title={t('managedMachines.config.size')} description={sizeDescription}><ManagedSizeTable sizes={sizes} value={selected.size ?? null}
        headroomTitle={billing.location === 'local' ? t('managedMachines.config.headroom', { computer: props.computer }) : undefined}
        onChange={id => props.onChange('size', id)} compact={props.compact} testID="managed-config.sizes" /></ItemGroup> : null;
    const imageSection = images.length ? <ItemGroup title={t('managedMachines.config.image')} description={t('managedMachines.config.imageDescription')}>
        <ManagedImageTiles images={images} value={selected.image ?? null} onChange={id => props.onChange('image', id)} testID="managed-config.images" /></ItemGroup> : null;
    // A local VM is chosen by what it runs (macOS or a Linux desktop) before its share of this computer;
    // a cloud machine by its size first (lab m-config L vs A).
    const local = billing.location === 'local';
    return <>
        {local ? imageSection : sizeSection}
        {local ? sizeSection : imageSection}
        {locations.length ? <ManagedLocationGroup locations={locations} value={selected.location ?? null} title={t('managedMachines.config.location')}
            description={local ? t('managedMachines.config.localLocationDescription', { computer: props.computer }) : t('managedMachines.config.locationDescription')}
            onChange={id => props.onChange('location', id)} testID="managed-config.locations" /> : null}
        {networks.length > 1 ? <ManagedNetworkGroup networks={networks} value={selected.network ?? null} title={t('managedMachines.config.network')}
            description={t('managedMachines.config.networkDescription')} onChange={id => props.onChange('network', id)} testID="managed-config.networks" /> : null}
    </>;
}

/** A required field with nothing entered: absent, empty text, or an empty list. */
function isBlankInput(value: unknown): boolean {
    return value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0;
}
