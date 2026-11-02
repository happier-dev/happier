import * as React from 'react';
import { randomUUID } from '@/platform/randomUUID';
import type { ManagedMachinePresetV1, PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ExternalActionManagedAdmissionReceiptV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedAcquireInputV1Schema, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { isMachineProvisionerCredentialPurposeRequiredV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { QualifiedConnectedAccountRefSchema, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { isMachineRetainedWakeEligibleV1, resolveMachineRetentionPolicyV1, supportedMachineRetentionEffectsV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { useIsMachineListSettled } from '@/sync/store/hooks';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
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
import { MANAGED_PROVISIONER_MARK_SIZE, useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { useManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';
import { useSettledSelectors } from './useSettledSelectors';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { buildSessionActionFieldOptionsResolver } from '@/components/sessions/actions/sessionActionFieldOptions';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import { readDeclaredConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { createMachinePresetCollectionClient } from './machinePresetCollectionClient';
import type { MachinePresetCollectionOptions, MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';
import { useMachinePresetQuery, isMachinePresetAccessLost } from './useMachinePresets';
import { isAuthoritativeScopedSnapshotRefusal } from '@/sync/domains/scope/scopedSnapshotFacts';
import { ManagedMachineConfigurator } from './ManagedMachineConfigurator';
import { ManagedCreationDisabledBanner } from './ManagedMachineStateRow';
import { useManagedControllerScope } from './useManagedControllerScope';
import { buildManagedConfigurationReceipt, describeLocalHeadroom, describeManagedConfigurationSummary, managedCredentialReceiptTargets } from './managedConfigurationPresentation';
import { MachineEnvironmentSection } from './MachineEnvironmentSection';
import { ManagedFieldRow, managedPresetLimitRow } from './MachinePresetDetail';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions,
    managedConfiguratorFacts, managedConfiguratorProjection, managedConfiguratorAcquireInput, managedConfiguratorOptionsSelectors, setManagedConfiguratorOptionsSelectors, setManagedConfiguratorCredentials, managedConfiguratorCredentialSelections, managedConfiguratorRetentionCapabilities,
    type ManagedConfiguratorDraft } from './managedConfiguratorModel';
import { describeRetentionConsequence, retentionCategoryTitle } from './managedRetentionPresentation';
import { countryName, formatProviderAmount, formatPriceUnit } from './managedMachineDisplay';
import { ManagedImagePreview, useManagedImagePreviews } from './useManagedImagePreviews';
import { ManagedSizeTable, ManagedImageTiles, ManagedLocationGroup, ManagedNetworkGroup } from './ManagedChoiceSections';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { managedConfiguratorDimensionChoices, managedConfiguratorDimensionSelection, selectManagedConfiguratorDimension } from './managedConfiguratorModel';
import { createManagedMachineSelectionDraft, type ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRetentionDuration } from './managedRetentionPresentation';
import { ConnectedServiceSetupPage } from '../../connectedServices/setup/ConnectedServiceSetupPage';
import type { ConnectedServiceSetupTarget } from '../../connectedServices/setup/ConnectedServiceSetupPanel';
import type { ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

const MORE_TEAMS = '__more-teams';

export type ManagedMachineConfigurationViewProps = Readonly<{
    serverId: string; provisioner: string; presetId?: string; presetOnly?: boolean; initialController?: ManagedControllerV1;
    /** Exact caller-supplied native query; never inferred from the viewing device's filesystem. */
    initialOptionsSelectors?: Readonly<Record<string, unknown>>;
    initialConnectPurpose?: string;
    /** Composer review commits local intent; only its explicit Send admits an acquisition. */
    onUse?: (draft: ManagedMachineSelectionDraft) => void;
}>;
export function ManagedMachineConfigurationView(props: ManagedMachineConfigurationViewProps) {
    return <ManagedMachineConfigurationViewBody key={JSON.stringify([props.serverId, props.provisioner, props.presetId, props.initialOptionsSelectors])} {...props} />;
}
function ManagedMachineConfigurationViewBody(props: ManagedMachineConfigurationViewProps) {
    const approvalHandler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => approvalHandler.current(registration), []);
    const router = useRouter();
    const compact = useViewportClass() === 'compact';
    const machines = useMachineListForServer(props.serverId) ?? [];
    const machineListSettled = useIsMachineListSettled(props.serverId);
    const [draft, setDraft] = React.useState<ManagedConfiguratorDraft | null>(null);
    const [preset, setPreset] = React.useState<ManagedMachinePresetV1 | null>(null);
    const loadedPreset = React.useRef<ManagedMachinePresetV1 | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [accountSetup, setAccountSetup] = React.useState<Readonly<{
        request: ConnectedAccountPurposeSetupRequest; controller: ManagedControllerV1; occurrenceId: string;
        selected: QualifiedConnectedAccountRef | null; target: ConnectedServiceSetupTarget;
    }> | null>(null);
    const [pendingCredential, setPendingCredential] = React.useState<Readonly<{
        setup: NonNullable<typeof accountSetup>; account: QualifiedConnectedAccountRef;
        basis: MachineProvisionersListResultV1['provisioners'][number];
    }> | null>(null);
    // "Managed from" is the page's scope: the header chip, starting on the handed-off or preset controller.
    const scope = useManagedControllerScope({ serverId: props.serverId, preferred: props.initialController ?? preset?.controller,
        disabled: busy, testIDPrefix: 'managed-config.controller',
        onSelect: React.useCallback((next: ManagedControllerV1) => setDraft(current => current
            ? { ...current, controller: next, check: undefined, optionStatus: 'loading' } : current), []) });
    const requestedController = draft?.controller ?? scope.controller;
    const catalogController = requestedController && machines.some(machine => machine.id === requestedController.machineId
        && machine.installationId === requestedController.installationId) ? requestedController : undefined;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, catalogController);
    // A page that names its controller (deep link, reload, handoff) before the Home's machine list has synced
    // has not been refused anything: it waits for the list that will either contain the controller or not.
    const controllerAwaitsMachineList = !!requestedController && !catalogController && !machineListSettled;
    const accountSettings = useManagedMachineAccountSettings(catalog.binding, catalog.resolution);
    const [teamId, setTeamId] = React.useState('');
    const [limit, setLimit] = React.useState<number | undefined>();
    const [error, setError] = React.useState<string | null>(null);
    const [saved, setSaved] = React.useState<Readonly<{ id: string; name: string; serverId: string }> | null>(null);
    const [readRevision, retry] = React.useReducer(value => value + 1, 0);
    const approval = useActionApprovalContinuation({ serverId: props.serverId,
        scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId, props.provisioner]), onExecuted: () => {} });
    approvalHandler.current = approval.requestApproval;
    const mutationAbort = React.useRef<AbortController | null>(null);
    const optionsAbort = React.useRef<AbortController | null>(null);
    const reviewed = React.useRef<ManagedConfigurationFactsV1 | null>(null);
    const catalogProvisioner = catalog.provisioners.find(row => buildQualifiedPluginContributionKey(row.contribution) === props.provisioner);
    // A retained catalog remains readable while the selected controller answers, but cannot admit credential-bearing work.
    const catalogCurrent = !catalog.loading && catalog.error === null;
    const openAccountSetup = (purposeId: string) => {
        const binding = catalog.binding;
        const purpose = catalogProvisioner?.credentialPurposes?.find(entry => entry.purpose.purpose === purposeId)?.purpose;
        if (!catalogCurrent || !draft || !binding?.isCurrent() || !catalogController || !catalogProvisioner || !purpose || busy) return;
        const selected = draft.credentials?.find(entry => qualifiedPurposeKey(entry.purpose) === qualifiedPurposeKey(purpose))?.account ?? null;
        setAccountSetup({ request: { scope: binding.scope, machineId: catalogController.machineId, purpose },
            controller: catalogController, occurrenceId: catalogProvisioner.occurrenceId, selected,
            target: selected ? { kind: 'reconnect', serviceKey: buildQualifiedPluginContributionKey(selected.service), accountId: selected.accountId }
                : { kind: 'catalog' } });
    };
    const initialConnectConsumed = React.useRef(false);
    React.useEffect(() => {
        if (initialConnectConsumed.current || !props.initialConnectPurpose || !catalogCurrent || !draft || !catalogProvisioner) return;
        initialConnectConsumed.current = true;
        openAccountSetup(props.initialConnectPurpose);
    }, [props.initialConnectPurpose, catalogCurrent, draft, catalogProvisioner, catalogController]);
    // Only this occurrence's controller-qualified catalog authorizes purpose choices. Account inventory is display-only.
    const credentialPurposes = React.useMemo(() => catalogProvisioner?.credentialPurposes?.filter(({ purpose }) =>
        isMachineProvisionerCredentialPurposeRequiredV1(catalogProvisioner.descriptor, purpose.purpose,
            draft?.optionsSelectors ?? draft?.selected?.launch)), [catalogProvisioner, draft?.optionsSelectors, draft?.selected]);
    const credentialSelections = React.useMemo(() => draft && catalogProvisioner
        ? managedConfiguratorCredentialSelections(draft, catalogProvisioner) : [], [catalogProvisioner, draft?.credentials, draft?.optionsSelectors, draft?.selected]);
    const requiredCredentials = draft?.credentials?.filter(credential => !catalogProvisioner || isMachineProvisionerCredentialPurposeRequiredV1(
        catalogProvisioner.descriptor, credential.purpose.purpose, draft.optionsSelectors ?? draft.selected?.launch)) ?? [];
    const credentialsCurrent = pluginJsonValuesEqual(requiredCredentials, credentialSelections);
    const credentialsReady = credentialPurposes !== undefined && credentialSelections.length === credentialPurposes.length && credentialsCurrent;
    const credentialInput = React.useMemo(() => Object.fromEntries((credentialPurposes ?? []).map(({ purpose }, index) => [String(index),
        credentialSelections.find(credential => qualifiedPurposeKey(credential.purpose) === qualifiedPurposeKey(purpose))?.account])), [credentialPurposes, credentialSelections]);
    // A retained draft describes what was reviewed; only the current catalog admits new reads or mutations.
    const provisioner = catalogProvisioner ?? draft?.provisioner;
    const controller = requestedController;
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: catalogController, provisioner, refreshKey: readRevision });
    const optionsInput = useManagedProvisionerOptionsInput({ binding: catalog.binding, controller: catalogController, provisioner: catalogProvisioner,
        projection: presentation.projection, projectionReady: presentation.projectionReady, projectionFailed: presentation.projectionFailed, refreshKey: readRevision });
    // The account a purpose draws on is named by its service, never by the purpose id.
    const connectedServices = useProjectedConnectedServicesRegistry();
    const localizeServiceText = useProjectedPluginLocalizedTextResolver();
    const purposeAccountTitle = React.useCallback((purpose: string) => {
        const service = provisioner && readDeclaredConnectedAccountPurposeV1({ purpose: { consumer: provisioner.contribution, purpose },
            projection: presentation.projection, machineProvisionersById: presentation.projection.machineProvisionersById })?.serviceRefs[0];
        return service ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServices, service, t, localizeServiceText) : undefined;
    }, [provisioner, presentation.projection, connectedServices, localizeServiceText]);
    // An account to choose from is a field; with none connected yet the Connect row below is the one way forward.
    const credentialFields = React.useMemo(() => resolveEffectiveActionInputFields({ inputHints: { fields: (credentialPurposes ?? []).flatMap(({ purpose, options }, index) => options.length === 0 ? [] : [{
        path: String(index), title: purposeAccountTitle(purpose.purpose) ?? t('managedMachines.receipt.account'), widget: 'select' as const, required: true, options,
    }]) } }, credentialInput), [credentialPurposes, credentialInput, purposeAccountTitle]);
    const credentialFieldOptions = React.useMemo(() => buildSessionActionFieldOptionsResolver({}), []);
    const optionHints = React.useMemo(() => optionsInput.kind === 'ready'
        ? resolvePluginProjectedActionPresentation({ pluginId: optionsInput.action.pluginId,
            presentation: optionsInput.action, projection: presentation.projection }).inputHints ?? undefined : undefined,
        [optionsInput, presentation.projection]);
    const selectors = React.useMemo(() => draft && optionsInput.kind === 'ready'
        ? managedConfiguratorOptionsSelectors(draft, optionsInput.schema, optionHints) : null,
        [draft?.optionsSelectors, draft?.selected, draft?.preset, optionsInput, optionHints]);
    const selectorKey = JSON.stringify(selectors);
    // The fields show the live draft; the provider is asked once the person pauses editing.
    const readSelectors = useSettledSelectors(selectors, selectorKey);
    const readSelectorKey = JSON.stringify(readSelectors);
    // The fields show what the read is asked with: the person's values over the provider's declared defaults.
    const fieldInput = React.useMemo<Record<string, unknown>>(() => {
        const base = draft?.optionsSelectors ? { ...draft.optionsSelectors }
            : selectors && typeof selectors === 'object' && !Array.isArray(selectors) ? { ...selectors } : {};
        return draft?.preset ? base : seedInputByFieldHints({ inputHints: optionHints }, base);
    }, [draft?.optionsSelectors, draft?.preset, selectorKey, optionHints]);
    const fields = React.useMemo(() => optionsInput.kind === 'ready'
        ? resolveEffectiveActionInputFields({ inputHints: optionHints }, fieldInput) : [],
        [optionsInput, optionHints, fieldInput]);
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
        ? async (options: MachinePresetCollectionOptions<ManagedMachinePresetV1>): Promise<MachinePresetCollectionSettledResult<ManagedMachinePresetV1>> => {
            const result = await presetClient.read('machines.presets.get', { homeId: catalog.homeId!, id: props.presetId! },
                { signal: options.signal, onApprovalPending: options.onApprovalPending });
            if (result.kind === 'failed') return result;
            return result.value.kind === 'found' ? { kind: 'succeeded', value: result.value.preset }
                : { kind: 'failed', code: result.value.code };
        } : null, [presetClient, catalog.homeId, props.presetId]);
    const presetQuery = useMachinePresetQuery({ serverId: props.serverId, homeId: catalog.homeId, presetId: props.presetId,
        binding: catalog.binding, resolution: catalog.resolution, read: readPreset, refreshRevision: readRevision, onApprovalPending,
        onAccessLost: clearProtectedPreset, onInvalidated: retry });
    const fieldOptions = useInputFieldOptions({ requests: fieldRequests, enabled: catalogCurrent && presetQuery.sameScope && !!draft && credentialsReady && optionsInput.kind === 'ready',
        serverId: catalog.binding?.serverId ?? props.serverId, machineId: controller?.machineId, accountLifetime: catalog.binding });
    const teamDenied = !!props.presetId && (preset?.owner.kind === 'team' || !!teamId) && team.kind === 'bound'
        && (team.state.kind === 'ready' && !team.state.team.capabilities.viewTeam
            || team.state.kind === 'unavailable' && isAuthoritativeScopedSnapshotRefusal(team.state.error));
    React.useEffect(() => {
        if (teamDenied && presetQuery.state.value) presetQuery.withdraw('permission_denied');
    }, [teamDenied, presetQuery.state.value, presetQuery.withdraw]);
    React.useEffect(() => {
        if (!presetQuery.sameScope || !catalogController || props.presetId || !provisioner) return;
        const initial = catalogController;
        if (!machines.some(machine => machine.id === initial.machineId && machine.installationId === initial.installationId)) return;
        setDraft(current => current ?? createManagedConfiguratorDraft({ provisioner, controller: initial, name: title,
            optionsSelectors: props.initialOptionsSelectors }));
    }, [presetQuery.sameScope, catalogController, props.presetId, props.initialOptionsSelectors, provisioner, machines, title]);
    React.useEffect(() => {
        if (!presetQuery.sameScope || !preset || !provisioner || teamDenied) return;
        setDraft(current => current ?? { ...createManagedConfiguratorDraft({ provisioner, controller: catalogController ?? preset.controller, name: preset.recipe.name,
            credentials: preset.recipe.credentials, environment: preset.environment,
            preset: { id: preset.id, revision: preset.revision, name: preset.name, retention: preset.retention, wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage } }),
            selected: { id: `preset:${preset.id}`, title: preset.name, launch: preset.recipe.choices } });
    }, [presetQuery.sameScope, preset, provisioner, catalogController, teamDenied]);

    React.useEffect(() => {
        if (!presetQuery.sameScope || !catalogProvisioner || !catalogController || catalogProvisioner.credentialPurposes === undefined) return;
        setDraft(current => {
            if (!current || current.controller.machineId !== catalogController.machineId
                || current.controller.installationId !== catalogController.installationId) return current;
            const selections = managedConfiguratorCredentialSelections(current, catalogProvisioner);
            const next = setManagedConfiguratorCredentials(current, selections);
            if (next.provisioner === catalogProvisioner) return next;
            return { ...next, provisioner: catalogProvisioner, choicesSchema: createManagedConfiguratorDraft({ provisioner: catalogProvisioner,
                controller: next.controller, name: next.name }).choicesSchema, optionStatus: 'loading', check: undefined };
        });
    }, [presetQuery.sameScope, catalogProvisioner, catalogController, draft?.credentials, draft?.provisioner]);

    React.useEffect(() => {
        if (!pendingCredential || catalog.loading || catalogProvisioner === pendingCredential.basis && !catalog.error) return;
        const { setup, account } = pendingCredential;
        const current = !catalog.error && catalog.binding?.isCurrent() && catalog.binding.scope.accountId === setup.request.scope.accountId
            && catalog.binding.scope.serverId === setup.request.scope.serverId
            && catalogController?.machineId === setup.controller.machineId
            && catalogController.installationId === setup.controller.installationId
            && catalogProvisioner?.occurrenceId === setup.occurrenceId;
        const selection = current && catalogProvisioner ? managedConfiguratorCredentialSelections({ credentials: [{ purpose: setup.request.purpose, account }] }, catalogProvisioner) : [];
        if (selection.length && catalogProvisioner) setDraft(value => value ? setManagedConfiguratorCredentials({ ...value, provisioner: catalogProvisioner }, [
            ...(value.credentials ?? []).filter(entry => qualifiedPurposeKey(entry.purpose) !== qualifiedPurposeKey(setup.request.purpose)), ...selection,
        ]) : value);
        else setError('credential_unavailable');
        setPendingCredential(null);
    }, [pendingCredential, catalog.loading, catalog.error, catalog.binding, catalogProvisioner, catalogController]);

    // Retirement cancels credential custody immediately. The query's exact scope/access owner clears presentation.
    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding) return;
        const retirement = binding.onRetire(() => {
            retirePending(); reviewed.current = null; setAccountSetup(null); setPendingCredential(null);
        });
        return () => { retirement.dispose(); mutationAbort.current?.abort(); optionsAbort.current?.abort(); };
    }, [catalog.binding, retirePending]);

    React.useEffect(() => {
        if (teamDenied) return;
        const row = presetQuery.state.value;
        if (row) {
            if (buildQualifiedPluginContributionKey(row.recipe.provider) !== props.provisioner) { setError('invalid_parameters'); return; }
            if (!loadedPreset.current) {
                setLimit(row.simultaneousLimit?.maximum); setTeamId(row.owner.kind === 'team' ? row.owner.teamId : '');
            }
            loadedPreset.current = row;
            setPreset(row);
            // Explicit conflict review advances the basis without replacing the person's edited recipe or policy.
            setDraft(current => current?.preset?.id === row.id ? { ...current,
                preset: { ...current.preset, revision: row.revision, name: row.name } } : current);
        }
        if (presetQuery.state.error) setError(presetQuery.state.error);
    }, [presetQuery.state.value, presetQuery.state.error, props.provisioner, teamDenied]);

    React.useEffect(() => {
        const binding = catalog.binding;
        if (!catalogCurrent || !presetQuery.sameScope || !binding || !catalog.homeId || !catalog.client || !controller) return;
        if (!catalogProvisioner || !catalogController || !credentialsReady) {
            setDraft(current => current && current.optionStatus !== 'unavailable'
                ? { ...current, optionStatus: 'unavailable', check: undefined } : current);
            return;
        }
        if (!draft || draft.provisioner !== catalogProvisioner) return;
        const abort = new AbortController();
        optionsAbort.current = abort;
        // A read in flight withdraws the last read's failure, as its answer would; options that cannot be read
        // (their input settled unavailable) are not "loading" while the check still runs.
        setError(optionsInput.kind === 'unavailable' ? optionsInput.error : null);
        setDraft(current => current ? { ...current, optionStatus: optionsInput.kind === 'unavailable' ? 'unavailable' : 'loading' } : current);
        const credentials = credentialSelections;
        const input = { homeId: catalog.homeId, controller, contribution: catalogProvisioner.contribution, ...(credentials.length ? { credentials } : {}) };
        void Promise.all([
            catalog.client.read('machines.provisioners.check', input, { signal: abort.signal, onApprovalPending }),
            optionsInput.kind === 'ready' && readSelectors !== null
                ? catalog.client.read('machines.provisioners.options', { ...input, selectors: readSelectors }, { signal: abort.signal, onApprovalPending })
                : Promise.resolve(null),
        ]).then(([check, options]) => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            setDraft(current => {
                if (!current) return current;
                let next: ManagedConfiguratorDraft = { ...current, check: check.kind === 'succeeded' ? check.value : undefined };
                if (options?.kind === 'succeeded') {
                    next = refreshManagedConfiguratorOptions(next, options.value, readSelectors ?? undefined);
                } else next = { ...next, optionStatus: optionsInput.kind === 'loading' ? 'loading' : 'unavailable' };
                return next;
            });
            setError(check.kind === 'failed' ? check.code : options?.kind === 'failed' ? options.code
                : optionsInput.kind === 'unavailable' ? optionsInput.error : null);
        }).catch(() => { if (!abort.signal.aborted) { setError('unavailable'); setDraft(current => current ? { ...current, optionStatus: 'unavailable' } : current); } });
        return () => abort.abort();
    }, [catalogCurrent, presetQuery.sameScope, catalog.binding, catalog.homeId, catalog.client, catalogProvisioner, catalogController, controller?.machineId, controller?.installationId,
        draft?.credentials, draft?.provisioner, credentialsReady, optionsInput, readSelectorKey, readRevision]);

    const effectiveDraft = React.useMemo(() => presetQuery.sameScope && draft && accountSettings.settings
        ? { ...draft, categoryPreferences: accountSettings.settings.machineRetentionDefaultsV1 } : null, [presetQuery.sameScope, draft, accountSettings.settings]);
    const projection = React.useMemo(() => effectiveDraft ? managedConfiguratorProjection(effectiveDraft) : null, [effectiveDraft]);
    const facts = React.useMemo(() => effectiveDraft ? managedConfiguratorFacts(effectiveDraft, projection) : null, [effectiveDraft, projection]);
    React.useEffect(() => { if (facts) reviewed.current = facts; }, [facts]);
    // A settings refresh may withdraw mutation authority, not what the person already reviewed.
    // A changed draft never borrows the old choice's facts, and only fresh `facts` can be submitted.
    const captured = reviewed.current;
    const receiptFacts = facts ?? (presetQuery.sameScope && catalog.binding?.isCurrent() && captured && draft?.selected
        && draft.name === captured.launch.name && draft.controller.machineId === captured.controller.machineId
        && draft.controller.installationId === captured.controller.installationId
        && pluginJsonValuesEqual(draft.credentials ?? [], captured.launch.credentials ?? [])
        && pluginJsonValuesEqual(draft.selected.launch, captured.launch.choices) ? captured : null);
    const credentialTargets = React.useMemo(() => receiptFacts ? managedCredentialReceiptTargets(receiptFacts.launch) : [], [receiptFacts?.launch]);
    const credentialAccounts = useQualifiedConnectedAccountTargetPresentations({ binding: catalog.binding, targets: credentialTargets });
    const retentionCapabilities = draft ? managedConfiguratorRetentionCapabilities(draft) : provisioner?.descriptor.retention;
    const defaultPolicy = provisioner ? resolveMachineRetentionPolicyV1({ billing: provisioner.descriptor.billing,
        nativeCapabilities: retentionCapabilities, presetOverride: props.presetOnly ? undefined : draft?.preset, categoryPreferences: accountSettings.settings?.machineRetentionDefaultsV1 }) : null;
    const finiteOnly = retentionCapabilities?.finiteOnly === true;
    const nativeDurationField = finiteOnly && provisioner?.descriptor.nativeDurationInput
        ? fields.find(field => field.path === provisioner.descriptor.nativeDurationInput?.path) : undefined;
    const recipeFields = fields.filter(field => field !== nativeDurationField);
    const keepPolicy = facts ?? (finiteOnly ? defaultPolicy : null);
    const nativeExpiry = retentionCapabilities?.nativeExpiry;
    const receiptController = receiptFacts?.controller ?? controller;
    const knownControllerName = getMachineDisplayName(machines.find(machine => machine.id === receiptController?.machineId
        && machine.installationId === receiptController?.installationId));
    const controllerName = knownControllerName ?? t('common.unknown');
    const activeBinding = catalog.binding;
    const mayCreate = catalogCurrent && !!catalogProvisioner && !!catalogController && !!facts && facts.optionStatus === 'current' && draft?.check?.available === true
        && credentialsReady
        && (!preset || preset.archivedAt === undefined) && accountSettings.settings?.managedMachineCreationEnabled === true && !!activeBinding?.isCurrent() && !busy;
    // A retained recipe can still be saved, but explicit field edits must satisfy the declared input schema.
    const maySave = catalogCurrent && !!catalogProvisioner && !!catalogController && !!facts
        && credentialsReady && (!credentialPurposes?.length || facts.optionStatus === 'current')
        && (draft?.optionsSelectors === undefined || selectors !== null && facts.optionStatus === 'current') && !!activeBinding?.isCurrent() && teamWritable && !busy;
    const presetRetention = draft?.override?.retention ?? draft?.preset?.retention;
    // A preset is reusable; this creation's absolute deadline remains only in its one-off draft.
    const reusablePresetRetention = presetRetention?.kind === 'deadline' ? undefined : presetRetention;
    const completedSave = (value: PresetMutationResultV1) => {
        if (!activeBinding?.isCurrent()) return;
        setBusy(false);
        if (value.kind === 'saved') { setSaved({ id: value.preset.id, name: value.preset.name, serverId: activeBinding.serverId }); setError(null); if (props.presetOnly) router.replace(`/settings/machines/presets/${encodeURIComponent(value.preset.id)}?serverId=${encodeURIComponent(activeBinding.serverId)}` as never); }
        else if (value.kind === 'refused' && props.presetId && isMachinePresetAccessLost(value.code)) presetQuery.withdraw(value.code);
        else setError(value.kind === 'conflict' ? 'conflict' : value.code);
    };
    const failed = (code: string) => { if (activeBinding?.isCurrent()) {
        if (props.presetId && isMachinePresetAccessLost(code)) presetQuery.withdraw(code);
        else { setBusy(false); setError(code); }
    } };
    const repair = async (action: NonNullable<ManagedPrerequisiteV1['repairAction']>) => {
        if (!catalogCurrent || !activeBinding?.isCurrent() || !catalogController || !catalogProvisioner || busy) return;
        const abort = new AbortController(); mutationAbort.current = abort;
        setBusy(true); setError(null);
        try {
            const outcome = await presentation.repair(action, activeBinding, abort.signal);
            if (abort.signal.aborted || !activeBinding.isCurrent()) return;
            setBusy(false);
            if (outcome.ok) retry(); else setError(outcome.reason);
        } catch { if (!abort.signal.aborted) failed('unavailable'); }
    };
    const save = async () => {
        if (!facts || !catalog.homeId || !activeBinding?.isCurrent() || !presetClient || !maySave) return;
        setBusy(true); setError(null);
        const abort = new AbortController(); mutationAbort.current = abort;
        const callbacks = { signal: abort.signal, onApprovalPending, onApprovalSucceeded: completedSave, onApprovalFailed: failed };
        try {
        const result = props.presetOnly && preset ? await presetClient.execute('machines.presets.update', {
            homeId: catalog.homeId, id: preset.id, expectedRevision: preset.revision,
            patch: { name: facts.launch.name, recipe: facts.launch, controller: facts.controller,
                environment: draft?.environment ?? null,
                retention: reusablePresetRetention ?? null,
                wakeOnAcceptedMessage: draft?.override?.wakeOnAcceptedMessage ?? draft?.preset?.wakeOnAcceptedMessage ?? null,
                simultaneousLimit: limit ? { maximum: limit } : null },
        }, callbacks) : await presetClient.execute('machines.presets.create', {
            homeId: catalog.homeId, id: randomUUID(), name: facts.launch.name, recipe: facts.launch,
            owner: teamId ? { kind: 'team', teamId } : { kind: 'account', accountId: activeBinding.accountId }, controller: facts.controller,
            ...(draft?.environment !== undefined ? { environment: draft.environment } : {}),
            ...(reusablePresetRetention ? { retention: reusablePresetRetention } : {}),
            ...((draft?.override?.wakeOnAcceptedMessage ?? draft?.preset?.wakeOnAcceptedMessage) !== undefined
                ? { wakeOnAcceptedMessage: draft?.override?.wakeOnAcceptedMessage ?? draft?.preset?.wakeOnAcceptedMessage } : {}),
            ...(limit ? { simultaneousLimit: { maximum: limit } } : {}),
        }, callbacks);
        if (!abort.signal.aborted) { if (result.kind === 'succeeded') completedSave(result.value); else if (result.kind === 'failed') failed(result.code); }
        } catch { if (!abort.signal.aborted) failed('unavailable'); }
    };
    const created = (value: ManagedMachineActionOutputV1<'machines.managed.acquire'>) => {
        if (activeBinding?.isCurrent()) router.replace(`/settings/machines/managed/${encodeURIComponent(value.managedId)}?serverId=${encodeURIComponent(activeBinding.serverId)}` as never);
    };
    // A correlated waiting admission opens its managed row; it is not a completed native Action.
    const admitted = (receipt: ExternalActionManagedAdmissionReceiptV1) => {
        if (activeBinding?.isCurrent()) router.replace(`/settings/machines/managed/${encodeURIComponent(receipt.managedId)}?serverId=${encodeURIComponent(activeBinding.serverId)}` as never);
    };
    const reviewedAcquireInput = () => {
        if (!effectiveDraft || !facts || !catalog.homeId || !mayCreate || !activeBinding?.isCurrent() || !catalog.client) return;
        return preset ? ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId: catalog.homeId, id: preset.id, revision: preset.revision },
            controller: facts.controller, retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage, reviewedFacts: facts })
            : managedConfiguratorAcquireInput(effectiveDraft, catalog.homeId);
    };
    const commitUse = () => {
        const input = reviewedAcquireInput();
        if (!input || !facts) return;
        props.onUse?.(createManagedMachineSelectionDraft({ selection: input.selection, receipt: facts }));
    };
    const create = async () => {
        const input = reviewedAcquireInput();
        if (!input || !activeBinding?.isCurrent() || !catalog.client) return;
        setBusy(true); setError(null);
        const abort = new AbortController(); mutationAbort.current = abort;
        try {
        const result = await catalog.client.execute('machines.managed.acquire', input, { signal: abort.signal, onApprovalPending, onApprovalSucceeded: created, onApprovalAdmitted: admitted, onApprovalFailed: failed });
        if (!abort.signal.aborted) { if (result.kind === 'succeeded') created(result.value); else if (result.kind === 'admitted') admitted(result.receipt); else if (result.kind === 'failed') failed(result.code); }
        } catch { if (!abort.signal.aborted) failed('unavailable'); }
    };
    const rename = async () => {
        if (!draft || !activeBinding?.isCurrent()) return;
        const name = await Modal.prompt(t('managedMachines.receipt.rename'), undefined, { defaultValue: draft.name });
        if (name?.trim() && activeBinding.isCurrent()) setDraft(current => current ? { ...current, name: name.trim() } : current);
    };
    const billedAccount = credentialAccounts.presentationsByKey['credential:0']?.primaryLabel;
    const billingFootnote = provisioner?.descriptor.billing.location === 'local'
        ? knownControllerName ? t('managedMachines.receipt.localFootnote', { provider: title, computer: knownControllerName }) : null
        : provisioner?.descriptor.billing.location === 'cloud' && billedAccount
            ? t('managedMachines.receipt.cloudFootnote', { provider: title, account: billedAccount }) : null;
    const receipt: ManagedReceiptModel = {
        ...(receiptFacts ? buildManagedConfigurationReceipt({ launch: receiptFacts.launch, reviewedFacts: receiptFacts, providerTitle: title, controllerName, homeName, mark: receiptMark, localized,
            credentialPresentations: credentialAccounts.presentationsByKey, keepEditedBelow: Boolean(keepPolicy && defaultPolicy) })
            // Before choices exist the receipt still tells the truth: a local VM bills nobody, and an unnamed draft
            // names its kind under the provider rather than repeating the provider twice.
            : { caption: t('managedMachines.receipt.yourNewMachine'), mark: receiptMark, name: draft?.name ?? title,
                spec: (draft?.name ?? title) === title ? presentation.kindTitle ?? title : title, facts: [],
                cost: provisioner?.descriptor.billing.location === 'local' && knownControllerName
                    ? { kind: 'local' as const, computer: knownControllerName, meters: [] }
                    : { kind: 'unpriced' as const, provider: title } }),
        onRename: !preset || props.presetOnly ? () => { void rename(); } : undefined,
        keep: keepPolicy && defaultPolicy ? { policy: keepPolicy, defaultPolicy, inherited: !draft?.override && (!props.presetOnly || !draft?.preset?.retention && draft?.preset?.wakeOnAcceptedMessage === undefined), categoryLabel: retentionCategoryTitle(defaultPolicy.category),
            finiteOnly, deadline: !props.presetOnly,
            ...(finiteOnly && draft && provisioner ? { nativeDuration: {
                value: managedConfiguratorDimensionSelection(draft).duration ?? null,
                choices: managedConfiguratorDimensionChoices(draft, 'duration').flatMap(({ choice, selectable }) => {
                    const duration = choice.nativeFacts?.duration;
                    return duration ? [{ id: duration.id, title: localized(provisioner.contribution.pluginId, duration.title),
                        unavailableReason: !selectable || busy || !!preset && !props.presetOnly ? t('managedMachines.options.unavailable') : undefined }] : [];
                }),
                onChange: id => setDraft(current => current ? selectManagedConfiguratorDimension(current, 'duration', id) : current),
                ...(provisioner.descriptor.nativeDurationInput ? { editor: nativeDurationField ? <ActionInputFields fields={[nativeDurationField]} input={fieldInput}
                    editable={!!catalogProvisioner && !!catalogController && !busy && (!preset || props.presetOnly === true)}
                    busy={busy} resolveFieldOptions={fieldOptions.resolveOptions} resolveFieldTestID={field => `managed-config.field:${field.path}`}
                    onPatch={patch => setDraft(current => current ? setManagedConfiguratorOptionsSelectors(current, { ...fieldInput, ...patch }) : current)} />
                    : <SurfaceStateCard kind="unavailable" size="line" title={t('managedMachines.options.unavailable')} /> } : {}),
            } } : {}),
            ...(nativeExpiry ? { nativeExpiry: t('managedRetention.nativeExpiry', { provider: title,
                time: nativeExpiry.kind === 'deadline' ? formatAsOfTime(nativeExpiry.at) : formatRetentionDuration(nativeExpiry.afterMs) }) } : {}),
            effects: retentionCapabilities && supportedMachineRetentionEffectsV1(retentionCapabilities.supportedIntents),
            canWake: retentionCapabilities !== undefined && isMachineRetainedWakeEligibleV1(keepPolicy.retention, retentionCapabilities),
            consequence: retention => describeRetentionConsequence(retention, { ...(provisioner?.descriptor.billing ?? { location: 'unknown', stoppedBilling: 'unknown' }), provider: title }),
            onChange: policy => setDraft(current => current ? { ...current, override: policy } : current),
            onReset: () => setDraft(current => current ? { ...current, override: undefined,
                preset: props.presetOnly && current.preset ? { id: current.preset.id, revision: current.preset.revision, name: current.preset.name } : current.preset } : current), disabled: !catalogController || !catalogProvisioner || busy } : undefined,
        primary: { label: props.presetOnly ? t('common.save') : props.onUse ? t('common.use') : provisioner?.descriptor.kindTitle
            ? t('managedMachines.receipt.createKind', { kind: localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) }) : t('managedMachines.add.create'),
            onPress: () => { if (props.presetOnly) void save(); else if (props.onUse) commitUse(); else void create(); },
            disabled: props.presetOnly ? !maySave : !mayCreate, loading: busy, testID: props.onUse && !props.presetOnly ? 'managed-config.use' : 'managed-config.create',
            // Who bills, under the action that starts the billing; only where the provisioner declares it.
            ...(!props.presetOnly && billingFootnote ? { footnote: billingFootnote } : {}) },
        secondary: !props.presetOnly ? [{ label: t('managedMachines.receipt.saveAsPreset'), onPress: () => { void save(); }, disabled: !maySave, testID: 'managed-config.save-preset', tone: 'text' }] : undefined,
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
    const summarySpec = [summaryLabel, summaryFacts ?? selectedTitle].filter(Boolean).join(' · ');
    if (accountSetup && !scope.selection) return <SurfaceStateCard kind="unavailable" title={t('managedMachines.providers.unavailable')}
        action={{ label: t('common.cancel'), onPress: () => setAccountSetup(null) }} />;
    if (accountSetup && scope.selection) return <ConnectedServiceSetupPage purposeRequest={accountSetup.request}
        selectedTarget={accountSetup.selected ? { kind: 'account', account: accountSetup.selected } : null}
        initialTarget={accountSetup.target} targetSelection={{ ...scope.selection,
            resolveExecutionTarget: () => {
                const target = scope.selection?.resolveExecutionTarget();
                return catalogCurrent && catalog.binding?.isCurrent() && target?.machine.id === accountSetup.controller.machineId
                    && target.machine.installationId === accountSetup.controller.installationId
                    && catalogProvisioner?.occurrenceId === accountSetup.occurrenceId ? target : null;
            },
        }}
        onClose={() => setAccountSetup(null)} onSelected={account => {
            if (!catalogCurrent || !catalog.binding?.isCurrent() || !catalogProvisioner || catalogProvisioner.occurrenceId !== accountSetup.occurrenceId
                || catalogController?.machineId !== accountSetup.controller.machineId
                || catalogController.installationId !== accountSetup.controller.installationId)
                throw new Error('connected_account_purpose_unavailable');
            setPendingCredential({ setup: accountSetup, account, basis: catalogProvisioner });
            setAccountSetup(null); catalog.refresh();
        }} />;
    if (props.presetId && (teamDenied || presetQuery.state.error && isMachinePresetAccessLost(presetQuery.state.error)))
        return <SurfaceStateCard kind="denied" title={t('machinePresets.accessLost')} testID="managed-config.error"
            action={{ label: t('managedMachines.actions.tryAgain'), onPress: retry }} />;
    // Before the provisioner is known the page keeps its own header (and with it the one way back), so the
    // state reads as this page's state rather than a loose section under the host's floating Back.
    const loadingCatalog = catalog.loading || controllerAwaitsMachineList;
    if (!presetQuery.sameScope || !provisioner) {
        // A read that failed names the controller it could not read and offers Retry, as Add does; on a phone the
        // header folds the chip into its overflow, so the scope leads as its own row and the way to another machine stays in view.
        const unreadableController = !loadingCatalog && catalog.error ? knownControllerName : undefined;
        return <ItemList pageColumn="wide">
            <PageHeader title={props.presetOnly ? t('machinePresets.title') : t('managedMachines.picker.newMachine')} actions={compact ? undefined : scope.chip} />
            {creationDisabledNotice}
            {compact && scope.chip ? <ItemGroup>
                <Item testID="managed-config.scope" title={t('managedMachines.config.managedFrom')} mode="info" showChevron={false} rightElement={scope.chip}
                    accessoryLayout="stacked" />
            </ItemGroup> : null}
            <ItemGroup surface="none">
                <SurfaceStateCard kind={loadingCatalog ? 'loading' : catalog.error ? 'error' : 'empty'} size="line"
                    title={unreadableController ? t('managedMachines.add.controllerUnreadable', { controller: unreadableController })
                        : t(loadingCatalog ? 'managedMachines.providers.loading' : 'managedMachines.providers.unavailable')}
                    diagnosticCode={catalog.error} testID="managed-config.catalog"
                    {...(catalog.error && !loadingCatalog ? { action: { label: t('common.retry'), onPress: catalog.refresh } } : {})} />
            </ItemGroup>
        </ItemList>;
    }
    const retainedChoice = facts?.optionStatus === 'unavailable' ? draft?.selected : undefined;
    const repairs = draft?.check?.prerequisites?.filter(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction) ?? [];
    // Nothing to choose from yet is not "no choices" while the recipe still waits on a required field: the field says what it needs.
    const awaitsRequiredInput = recipeFields.some(field => field.required && isBlankInput(readInputPath(fieldInput, field.path)));
    // A failed read leaves nothing to fill a blank required field from: the failure takes the fields' place, not a column of empty boxes.
    const readFailed = !!error && error !== 'conflict';
    const showRecipeFields = recipeFields.length > 0 && !(readFailed && awaitsRequiredInput);
    // A failed check is the cause: its own words say why and what to do ("Not installed · get it from …"), ahead of the option
    // reads that fail because of it. The generic line only fills the gap when the check named nothing.
    const choiceState = !draft ? null
        : draft.check?.available === false ? <SurfaceStateCard kind="warning" size="line" testID="managed-config.unavailable" title={t('managedMachines.providers.unavailable')}
            reason={draft.check.status ? localized(provisioner.contribution.pluginId, draft.check.status) : undefined} />
        : facts?.optionStatus === 'unavailable' ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.options.unavailable')} />
        : draft.optionStatus === 'loading' ? <SurfaceStateCard kind="loading" size="line" title={t('managedMachines.options.loading', { provider: title })} />
        : draft.optionStatus === 'current' && !draft.options?.base && !Object.values(draft.options?.dimensions ?? {}).some(rows => rows.length) ? (awaitsRequiredInput ? null : <SurfaceStateCard kind="empty" size="line" title={t('managedMachines.options.empty', { provider: title })} />)
        : null;
    const kindTitle = presentation.kindTitle;
    const pageTitle = props.presetOnly || !kindTitle ? title : t('managedMachines.config.newKind', { provider: title, kind: kindTitle });
    // Unpriced, the bar's value stays short; the sentence belongs to the receipt. No price yet is no value, not a placeholder.
    const summaryValue = summaryPrice ? formatProviderAmount(summaryPrice) : receiptFacts?.billing.location === 'local' ? t('managedMachines.price.noBill') : '';
    return <ManagedMachineConfigurator title={pageTitle} description={props.presetOnly ? t('machinePresets.futureOnly') : compact ? undefined : t('managedMachines.config.description')} mark={mark}
        actions={scope.chip}
        compact={compact} testID="managed-config" receipt={receipt} summary={{ value: summaryValue,
            unit: summaryPrice ? formatPriceUnit(summaryPrice.unit) : '', spec: summarySpec }}>
        {approval.approvalId ? <AttentionBanner testID="managed-config.approval" title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {creationDisabledNotice}
        {/* A failure leads the form column, where the choices would be: below a long page it would sit out of sight on a phone. */}
        {error ? <ItemGroup>
            <SurfaceStateCard kind="error" size="line" title={error === 'conflict' ? t('machinePresets.conflict') : t('managedMachines.options.error')}
                diagnosticCode={error === 'conflict' ? undefined : error} testID="managed-config.error"
                action={{ label: t(error === 'conflict' ? 'managedMachines.actions.review' : 'managedMachines.actions.tryAgain'), onPress: retry }} />
        </ItemGroup> : null}
        {draft && credentialPurposes?.length ? <ItemGroup title={t('managedMachines.receipt.account')}
            description={credentialsReady ? undefined : t(credentialPurposes.some(({ options }) => options.length === 0) ? 'managedMachines.credential.required' : 'managedMachines.credential.choose')}>
            {credentialFields.length ? <ActionInputFields fields={credentialFields} input={credentialInput}
                editable={!!catalogProvisioner && !!catalogController && !busy && (!preset || props.presetOnly === true)} busy={busy}
                resolveFieldOptions={credentialFieldOptions} resolveFieldTestID={field => `managed-config.credential:${credentialPurposes?.[Number(field.path)]?.purpose.purpose}`}
                onPatch={patch => {
                    if (!catalogProvisioner || !catalogController || busy || preset && !props.presetOnly) return;
                    const input = { ...credentialInput, ...patch };
                    const selections = (credentialPurposes ?? []).flatMap(({ purpose }, index) => {
                        const parsed = QualifiedConnectedAccountRefSchema.safeParse(input[String(index)]);
                        return parsed.success ? [{ purpose, account: parsed.data }] : [];
                    });
                    setDraft(current => current ? setManagedConfiguratorCredentials(current,
                        managedConfiguratorCredentialSelections({ credentials: selections }, catalogProvisioner)) : current);
                }} /> : null}
            {credentialPurposes?.map(({ purpose }) => <Item key={qualifiedPurposeKey(purpose)}
                testID={`managed-config.connect:${purpose.purpose}`} title={t(credentialSelections.some(entry =>
                    qualifiedPurposeKey(entry.purpose) === qualifiedPurposeKey(purpose)) ? 'connectedServices.detail.actions.reconnect' : 'managedMachines.add.action.connect')}
                subtitle={purposeAccountTitle(purpose.purpose)}
                disabled={!catalogController || !catalogProvisioner || busy || !!preset && !props.presetOnly}
                onPress={() => openAccountSetup(purpose.purpose)} />)}
        </ItemGroup> : null}
        {draft && showRecipeFields ? <ItemGroup title={t('managedMachines.detail.recipeTitle')}>
            <ActionInputFields fields={recipeFields} input={fieldInput} editable={!!catalogProvisioner && !!catalogController && !busy && (!preset || props.presetOnly === true)}
                busy={busy} resolveFieldOptions={fieldOptions.resolveOptions} resolveFieldTestID={field => `managed-config.field:${field.path}`}
                onPatch={patch => setDraft(current => current ? setManagedConfiguratorOptionsSelectors(current, { ...fieldInput, ...patch }) : current)} />
            {selectors === null ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.options.unavailable')} diagnosticCode="invalid_parameters" /> : null}
        </ItemGroup> : null}
        {draft && (retainedChoice || choiceState || repairs.length) ? <ItemGroup title={retainedChoice ? t('managedMachines.config.otherChoices') : undefined}>
            {retainedChoice ? <Item testID="managed-config.retained-choice" mode="info" title={localized(provisioner.contribution.pluginId, retainedChoice.title)}
                subtitle={t('managedMachines.options.unavailable')} selected showChevron={false} /> : null}
            {choiceState}
            {repairs.map(prerequisite => {
                const id = typeof prerequisite.requirement.id === 'string' ? prerequisite.requirement.id
                    : buildQualifiedPluginContributionKey(prerequisite.requirement.id);
                return <Item key={`${prerequisite.requirement.kind}:${id}`}
                    testID={`managed-config.repair:${prerequisite.requirement.kind}:${id}`}
                    title={t('managedMachines.add.action.setUp')} subtitle={prerequisite.reason ?? id}
                    disabled={!catalogController || !catalogProvisioner || busy} onPress={() => { if (prerequisite.repairAction) void repair(prerequisite.repairAction); }} />;
            })}
        </ItemGroup> : null}
        {draft ? <ManagedConfiguratorNativeChoices serverId={props.serverId} draft={draft} localized={localized} compact={compact} computer={controllerName} disabled={!catalogProvisioner || !catalogController || busy || !!preset && !props.presetOnly}
            onChange={(dimension, id) => setDraft(current => current ? selectManagedConfiguratorDimension(current, dimension, id) : current)} /> : null}
        {/* Setup belongs to a preset revision; a one-off Create never runs it, so only the preset editor offers it. */}
        {draft && props.presetOnly ? <MachineEnvironmentSection testID="managed-config.environment" environment={draft.environment}
            editable={!!catalogProvisioner && !!catalogController && !busy} scope={activeBinding?.scope ?? null}
            onChange={environment => setDraft(current => current ? { ...current, environment } : current)} /> : null}
        {/* Who can use it and how many may run belong to a preset, never to a one-off machine (lab m-presets). */}
        {draft && props.presetOnly ? <ItemGroup title={t('machinePresets.audience')}>
            <ManagedFieldRow testID="managed-config.audience" row={{ title: t('machinePresets.canUse'),
                choices: [{ id: '', title: t('machinePresets.ownerPersonal') },
                    ...teams.rows.filter(row => row.team.capabilities.manageSettings).map(row => ({ id: row.team.id, title: row.team.name })),
                    ...(teams.hasMore ? [{ id: MORE_TEAMS, title: t('machinePresets.moreTeams') }] : [])],
                value: teamId, disabled: !!preset || busy || teams.stale,
                onChange: id => { if (id === MORE_TEAMS) teams.loadMore(); else setTeamId(id); } }} />
        </ItemGroup> : null}
        {draft && props.presetOnly ? <ItemGroup title={t('machinePresets.runningAtOnce')} description={t('machinePresets.limitHelp')}>
            <ManagedFieldRow testID="managed-config.limit" row={managedPresetLimitRow({ limit, disabled: busy,
                onChange: next => { if (activeBinding?.isCurrent()) setLimit(next); } })} />
        </ItemGroup> : null}
        {saved && !props.presetOnly ? <SurfaceStateCard testID="managed-config.saved" kind="success" size="line" title={t('machinePresets.saved', { name: saved.name })}
            action={{ label: t('machinePresets.openPreset'), onPress: () => router.push(`/settings/machines/presets/${encodeURIComponent(saved.id)}?serverId=${encodeURIComponent(saved.serverId)}` as never) }} /> : null}
    </ManagedMachineConfigurator>;
}

/** The labelled dimensions select complete, provider-returned variants through the draft owner. */
function ManagedConfiguratorNativeChoices(props: Readonly<{
    serverId: string;
    draft: ManagedConfiguratorDraft;
    localized: ReturnType<typeof useManagedProvisionerPresentation>['localized'];
    compact: boolean; disabled: boolean;
    /** The computer a local VM shares, named in its size section. */
    computer: string;
    onChange: (dimension: 'size' | 'image' | 'location' | 'network', id: string) => void;
}>) {
    const { draft } = props;
    const pluginId = draft.provisioner.contribution.pluginId;
    const selected = managedConfiguratorDimensionSelection(draft);
    // While a read is running, the last answer stands: a row is only gone once a settled read lacks it.
    const settled = draft.optionStatus !== 'loading';
    // A choice says why it can't be picked: never offered here (this computer can't run it, or the provider
    // doesn't offer it), or only not with the other picks.
    const notHere = draft.provisioner.descriptor.billing.location === 'local'
        ? t('managedMachines.options.unavailableOn', { computer: props.computer })
        : t('managedMachines.options.notOffered', { provider: props.localized(pluginId, draft.provisioner.descriptor.title) });
    const unavailable = (available: boolean, selectable: boolean) => props.disabled ? t('managedMachines.options.unavailable')
        : available || !settled ? undefined : selectable ? t('managedMachines.options.unavailableWithChoices') : notHere;
    const sizes = managedConfiguratorDimensionChoices(draft, 'size').flatMap(({ choice, available, selectable }) => {
        const size = choice.nativeFacts?.size;
        if (!size) return [];
        const hourly = choice.prices?.find(price => price.unit === 'hour');
        const monthly = choice.prices?.find(price => price.unit === 'month');
        return [{ id: choice.id, name: props.localized(pluginId, choice.title), cpu: size.cpuCores === undefined ? '' : String(size.cpuCores),
            memory: size.memoryBytes === undefined ? '' : formatHappierDataBytes(size.memoryBytes, { kind: 'memory' }), disk: size.diskBytes === undefined ? '' : formatHappierDataBytes(size.diskBytes, { kind: 'storage' }),
            spec: props.localized(pluginId, size.title), ...(hourly ? { hourly: formatProviderAmount(hourly) } : {}),
            ...(monthly ? { monthly: formatProviderAmount(monthly) } : {}),
            headroom: draft.provisioner.descriptor.billing.location === 'local' ? describeLocalHeadroom(size, draft.check?.localResources) : undefined,
            unavailableReason: unavailable(available, selectable), selectable: selectable && !props.disabled }];
    });
    const imageChoices = managedConfiguratorDimensionChoices(draft, 'image');
    const previews = useManagedImagePreviews({ serverId: props.serverId, controllerMachineId: draft.controller.machineId,
        pluginId, occurrenceId: draft.provisioner.occurrenceId,
        requests: imageChoices.flatMap(({ choice }) => {
            const image = choice.nativeFacts?.image;
            return image?.preview ? [{ imageId: image.id, resource: image.preview.resource }] : [];
        }) });
    const images = imageChoices.flatMap(({ choice, available, selectable }) => {
        const image = choice.nativeFacts?.image;
        const preview = image ? previews.get(image.id) : undefined;
        return image ? [{ id: choice.id, name: props.localized(pluginId, choice.title),
            ...(preview ? { preview: <ManagedImagePreview source={preview}
                accessibilityLabel={image.preview?.accessibilityLabel ? props.localized(pluginId, image.preview.accessibilityLabel) : undefined} /> } : {}),
            description: unavailable(available, selectable) ?? (image.description ? props.localized(pluginId, image.description) : ''), unavailableReason: unavailable(available, selectable),
            selectable: selectable && !props.disabled }] : [];
    });
    const locations = managedConfiguratorDimensionChoices(draft, 'location').flatMap(({ choice, available, selectable }) => {
        const location = choice.nativeFacts?.location;
        // The country comes only from the provider's own ISO code, named in the reader's language.
        return location ? [{ id: choice.id, city: props.localized(pluginId, choice.title), countryCode: location.countryCode,
            country: countryName(location.countryCode, getPreferredLanguage()), unavailableReason: unavailable(available, selectable), selectable: selectable && !props.disabled }] : [];
    });
    const networks = managedConfiguratorDimensionChoices(draft, 'network').flatMap(({ choice, available, selectable }) => {
        const network = choice.nativeFacts?.network;
        return network ? [{ id: choice.id, name: props.localized(pluginId, choice.title),
            unavailableReason: unavailable(available, selectable), selectable: selectable && !props.disabled }] : [];
    });
    const firstPrice = managedConfiguratorDimensionChoices(draft, 'size').flatMap(({ choice }) => choice.prices ?? [])[0];
    const billing = draft.provisioner.descriptor.billing;
    // The section says where the prices come from and when they bill, or, locally, whose share it is.
    const sizeDescription = billing.location === 'local' ? t('managedMachines.config.localSizeDescription', { computer: props.computer })
        : [firstPrice ? t('managedMachines.config.pricesChecked', { provider: firstPrice.source, time: formatAsOfTime(firstPrice.observedAt) })
            : t('managedMachines.price.unavailable', { provider: props.localized(pluginId, draft.provisioner.descriptor.title) }),
            billing.stoppedBilling === 'billed' ? t('managedMachines.config.billedWhileExists')
                : billing.stoppedBilling === 'not-billed' ? t('managedMachines.config.billedWhileRunning') : null]
            .filter((part): part is string => part !== null).join(' ') || undefined;
    const sizeSection = sizes.length ? <ItemGroup title={t('managedMachines.config.size')} description={sizeDescription}><ManagedSizeTable sizes={sizes} value={selected.size ?? null}
        headroomTitle={billing.location === 'local' ? t('managedMachines.config.headroom', { computer: props.computer }) : undefined}
        onChange={id => props.onChange('size', id)} compact={props.compact} testID="managed-config.sizes" /></ItemGroup> : null;
    const imageSection = images.length ? <ItemGroup title={t('managedMachines.config.image')} description={t('managedMachines.config.imageDescription')}>
        <ManagedImageTiles images={images} value={selected.image ?? null} onChange={id => props.onChange('image', id)} testID="managed-config.images" /></ItemGroup> : null;
    // A local VM is chosen by what it runs (macOS or a Linux desktop) before its share of this computer;
    // a cloud machine by its size first (lab m-config L vs A).
    const local = draft.provisioner.descriptor.billing.location === 'local';
    return <>
        {local ? imageSection : sizeSection}
        {local ? sizeSection : imageSection}
        {locations.length ? <ManagedLocationGroup locations={locations} value={selected.location ?? null} title={t('managedMachines.config.location')}
            description={local ? t('managedMachines.config.localLocationDescription', { computer: props.computer }) : t('managedMachines.config.locationDescription')}
            onChange={id => props.onChange('location', id)} testID="managed-config.locations" /> : null}
        {networks.length ? <ManagedNetworkGroup networks={networks} value={selected.network ?? null} title={t('managedMachines.config.network')}
            description={t('managedMachines.config.networkDescription')}
            onChange={id => props.onChange('network', id)} testID="managed-config.networks" /> : null}
    </>;
}

/** A required field with nothing entered: absent, empty text, or an empty list. */
function isBlankInput(value: unknown): boolean {
    return value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0;
}
