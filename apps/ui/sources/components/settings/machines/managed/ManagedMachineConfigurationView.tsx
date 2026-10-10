import * as React from 'react';
import { randomUUID } from '@/platform/randomUUID';
import type { ManagedMachinePresetV1, PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ExternalActionManagedAdmissionReceiptV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedAcquireInputV1Schema, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { isMachineProvisionerCredentialPurposeRequiredV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { isMachineRetainedWakeEligibleV1, resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { useManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { buildSessionActionFieldOptionsResolver } from '@/components/sessions/actions/sessionActionFieldOptions';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import { createMachinePresetCollectionClient } from './machinePresetCollectionClient';
import type { MachinePresetCollectionOptions, MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';
import { useMachinePresetQuery, isMachinePresetAccessLost } from './useMachinePresets';
import { isAuthoritativeScopedSnapshotRefusal } from '@/sync/domains/scope/scopedSnapshotFacts';
import { ManagedMachineConfigurator } from './ManagedMachineConfigurator';
import { ManagedCreationDisabledBanner } from './ManagedMachineStateRow';
import { useManagedControllerScope } from './useManagedControllerScope';
import { buildManagedConfigurationReceipt, describeLocalHeadroom, describeManagedConfigurationSummary, managedCredentialReceiptTargets } from './managedConfigurationPresentation';
import { MachineEnvironmentSection } from './MachineEnvironmentSection';
import { ManagedFieldRow } from './MachinePresetDetail';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions, selectManagedConfiguratorChoice,
    managedConfiguratorFacts, managedConfiguratorAcquireInput, managedConfiguratorOptionsSelectors, setManagedConfiguratorOptionsSelectors, setManagedConfiguratorCredentials, managedConfiguratorCredentialSelections, managedConfiguratorRetentionCapabilities,
    type ManagedConfiguratorDraft } from './managedConfiguratorModel';
import { describeRetentionConsequence, retentionCategoryTitle } from './managedRetentionPresentation';
import { countryName, formatProviderAmount, formatPriceUnit } from './managedMachineDisplay';
import { ManagedImagePreview, useManagedImagePreviews } from './useManagedImagePreviews';
import { ManagedSizeTable, ManagedImageTiles, ManagedLocationGroup } from './ManagedChoiceSections';
import { formatByteCapacity } from '@/utils/files/formatByteSize';
import { managedConfiguratorDimensionChoices, managedConfiguratorDimensionSelection, selectManagedConfiguratorDimension } from './managedConfiguratorModel';
import { createManagedMachineSelectionDraft, type ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRetentionDuration } from './managedRetentionPresentation';

/** The common simultaneous limits offered in one tap; any other positive number stays one choice away. */
const LIMIT_CHOICES: readonly number[] = [1, 2, 3, 4, 5, 10];
const MORE_TEAMS = '__more-teams';
const OTHER_LIMIT = '__other-limit';

export type ManagedMachineConfigurationViewProps = Readonly<{
    serverId: string; provisioner: string; presetId?: string; presetOnly?: boolean; initialController?: ManagedControllerV1;
    /** Exact caller-supplied native query; never inferred from the viewing device's filesystem. */
    initialOptionsSelectors?: Readonly<Record<string, unknown>>;
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
    const [draft, setDraft] = React.useState<ManagedConfiguratorDraft | null>(null);
    const [preset, setPreset] = React.useState<ManagedMachinePresetV1 | null>(null);
    const loadedPreset = React.useRef<ManagedMachinePresetV1 | null>(null);
    const [busy, setBusy] = React.useState(false);
    // "Managed from" is the page's scope: the header chip, starting on the handed-off or preset controller.
    const scope = useManagedControllerScope({ serverId: props.serverId, preferred: props.initialController ?? preset?.controller,
        disabled: busy, testIDPrefix: 'managed-config.controller',
        onSelect: React.useCallback((next: ManagedControllerV1) => setDraft(current => current
            ? { ...current, controller: next, check: undefined, optionStatus: 'loading' } : current), []) });
    const requestedController = draft?.controller ?? scope.controller;
    const catalogController = requestedController && machines.some(machine => machine.id === requestedController.machineId
        && machine.installationId === requestedController.installationId) ? requestedController : undefined;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, catalogController);
    const accountSettings = useManagedMachineAccountSettings(catalog.binding ?? undefined);
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
    const credentialFields = React.useMemo(() => resolveEffectiveActionInputFields({ inputHints: { fields: (credentialPurposes ?? []).map(({ purpose, options }, index) => ({
        path: String(index), title: `${t('connectedServices.title')} · ${purpose.purpose}`, widget: 'select' as const, required: true, options,
    })) } }, credentialInput), [credentialPurposes, credentialInput]);
    const credentialFieldOptions = React.useMemo(() => buildSessionActionFieldOptionsResolver({}), []);
    // A retained draft describes what was reviewed; only the current catalog admits new reads or mutations.
    const provisioner = catalogProvisioner ?? draft?.provisioner;
    const controller = requestedController;
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: catalogController, provisioner });
    const optionsInput = useManagedProvisionerOptionsInput({ binding: catalog.binding, controller: catalogController, provisioner: catalogProvisioner,
        projection: presentation.projection, projectionReady: presentation.projectionReady });
    const selectors = React.useMemo(() => draft && optionsInput.kind === 'ready'
        ? managedConfiguratorOptionsSelectors(draft, optionsInput.schema) : null,
        [draft?.optionsSelectors, draft?.selected, draft?.preset, optionsInput]);
    const selectorKey = JSON.stringify(selectors);
    const fieldInput = React.useMemo<Record<string, unknown>>(() => draft?.optionsSelectors ? { ...draft.optionsSelectors }
        : selectors && typeof selectors === 'object' && !Array.isArray(selectors) ? { ...selectors } : {}, [draft?.optionsSelectors, selectorKey]);
    const fields = React.useMemo(() => {
        if (optionsInput.kind !== 'ready') return [];
        const resolved = resolvePluginProjectedActionPresentation({ pluginId: optionsInput.action.pluginId,
            presentation: optionsInput.action, projection: presentation.projection });
        return resolveEffectiveActionInputFields({ inputHints: resolved.inputHints ?? undefined }, fieldInput);
    }, [optionsInput, presentation.projection, fieldInput]);
    const fieldRequests = React.useMemo(() => optionsInput.kind === 'ready' ? fields.map(field => ({ field,
        actionId: buildQualifiedPluginContributionKey({ pluginId: optionsInput.action.pluginId, localId: optionsInput.action.id }), draftInput: fieldInput })) : [],
        [fields, fieldInput, optionsInput]);
    const fieldOptions = useInputFieldOptions({ requests: fieldRequests, enabled: !!draft && credentialsReady && optionsInput.kind === 'ready',
        serverId: catalog.binding?.serverId ?? props.serverId, machineId: controller?.machineId, accountLifetime: catalog.binding });
    const { localized, mark } = presentation;
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
        binding: catalog.binding, read: readPreset, refreshRevision: readRevision, onApprovalPending,
        onAccessLost: clearProtectedPreset, onInvalidated: () => { retirePending(); retry(); } });
    const teamDenied = !!props.presetId && (preset?.owner.kind === 'team' || !!teamId) && team.kind === 'bound'
        && (team.state.kind === 'ready' && !team.state.team.capabilities.viewTeam
            || team.state.kind === 'unavailable' && isAuthoritativeScopedSnapshotRefusal(team.state.error));
    React.useEffect(() => {
        if (teamDenied && presetQuery.state.value) presetQuery.withdraw('permission_denied');
    }, [teamDenied, presetQuery.state.value, presetQuery.withdraw]);
    React.useEffect(() => {
        if (!catalogController || props.presetId || !provisioner) return;
        const initial = catalogController;
        if (!machines.some(machine => machine.id === initial.machineId && machine.installationId === initial.installationId)) return;
        setDraft(current => current ?? createManagedConfiguratorDraft({ provisioner, controller: initial, name: title,
            optionsSelectors: props.initialOptionsSelectors }));
    }, [catalogController, props.presetId, props.initialOptionsSelectors, provisioner, machines, title]);
    React.useEffect(() => {
        if (!preset || !provisioner || teamDenied) return;
        setDraft(current => current ?? { ...createManagedConfiguratorDraft({ provisioner, controller: catalogController ?? preset.controller, name: preset.recipe.name,
            credentials: preset.recipe.credentials, environment: preset.environment,
            preset: { id: preset.id, revision: preset.revision, name: preset.name, retention: preset.retention, wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage } }),
            selected: { id: `preset:${preset.id}`, title: preset.name, launch: preset.recipe.choices } });
    }, [preset, provisioner, catalogController, teamDenied]);

    React.useEffect(() => {
        if (!catalogProvisioner || !catalogController || catalogProvisioner.credentialPurposes === undefined) return;
        setDraft(current => {
            if (!current || current.controller.machineId !== catalogController.machineId
                || current.controller.installationId !== catalogController.installationId) return current;
            const selections = managedConfiguratorCredentialSelections(current, catalogProvisioner);
            const next = setManagedConfiguratorCredentials(current, selections);
            if (next.provisioner === catalogProvisioner) return next;
            return { ...next, provisioner: catalogProvisioner, choicesSchema: createManagedConfiguratorDraft({ provisioner: catalogProvisioner,
                controller: next.controller, name: next.name }).choicesSchema, optionStatus: 'loading', check: undefined };
        });
    }, [catalogProvisioner, catalogController, draft?.credentials, draft?.provisioner]);

    // Credential retirement removes both presentation data and mutation custody, including open approvals.
    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding) return;
        const retirement = binding.onRetire(() => {
            clearProtectedPreset('action_account_scope_changed'); setTeamId('');
        });
        return () => { retirement.dispose(); mutationAbort.current?.abort(); optionsAbort.current?.abort(); };
    }, [catalog.binding, clearProtectedPreset, retirePending]);

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
        if (!binding || !catalog.homeId || !catalog.client || !controller) return;
        if (!catalogProvisioner || !catalogController || !credentialsReady) {
            setDraft(current => current && current.optionStatus !== 'unavailable'
                ? { ...current, optionStatus: 'unavailable', check: undefined } : current);
            return;
        }
        if (!draft || draft.provisioner !== catalogProvisioner) return;
        const abort = new AbortController();
        optionsAbort.current = abort;
        setDraft(current => current ? { ...current, optionStatus: 'loading' } : current);
        const credentials = credentialSelections;
        const input = { homeId: catalog.homeId, controller, contribution: catalogProvisioner.contribution, ...(credentials.length ? { credentials } : {}) };
        void Promise.all([
            catalog.client.read('machines.provisioners.check', input, { signal: abort.signal, onApprovalPending }),
            optionsInput.kind === 'ready' && selectors !== null
                ? catalog.client.read('machines.provisioners.options', { ...input, selectors }, { signal: abort.signal, onApprovalPending })
                : Promise.resolve(null),
        ]).then(([check, options]) => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            setDraft(current => {
                if (!current) return current;
                let next: ManagedConfiguratorDraft = { ...current, check: check.kind === 'succeeded' ? check.value : undefined };
                if (options?.kind === 'succeeded') {
                    next = refreshManagedConfiguratorOptions(next, options.value);
                } else next = { ...next, optionStatus: optionsInput.kind === 'loading' ? 'loading' : 'unavailable' };
                return next;
            });
            setError(check.kind === 'failed' ? check.code : options?.kind === 'failed' ? options.code
                : optionsInput.kind === 'unavailable' ? optionsInput.error : null);
        }).catch(() => { if (!abort.signal.aborted) { setError('unavailable'); setDraft(current => current ? { ...current, optionStatus: 'unavailable' } : current); } });
        return () => abort.abort();
    }, [catalog.binding, catalog.homeId, catalog.client, catalogProvisioner, catalogController, controller?.machineId, controller?.installationId,
        draft?.credentials, draft?.provisioner, credentialsReady, optionsInput, selectorKey, readRevision]);

    const effectiveDraft = React.useMemo(() => draft && accountSettings.settings
        ? { ...draft, categoryPreferences: accountSettings.settings.machineRetentionDefaultsV1 } : null, [draft, accountSettings.settings]);
    const facts = React.useMemo(() => effectiveDraft ? managedConfiguratorFacts(effectiveDraft) : null, [effectiveDraft]);
    React.useEffect(() => { if (facts) reviewed.current = facts; }, [facts]);
    // A settings refresh may withdraw mutation authority, not what the person already reviewed.
    // A changed draft never borrows the old choice's facts, and only fresh `facts` can be submitted.
    const captured = reviewed.current;
    const receiptFacts = facts ?? (catalog.binding?.isCurrent() && captured && draft?.selected
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
    const mayCreate = !!catalogProvisioner && !!catalogController && !!facts && facts.optionStatus === 'current' && draft?.check?.available === true
        && credentialsReady
        && (!preset || preset.archivedAt === undefined) && accountSettings.settings?.managedMachineCreationEnabled === true && !!activeBinding?.isCurrent() && !busy;
    // A retained recipe can still be saved, but explicit field edits must satisfy the declared input schema.
    const maySave = !!catalogProvisioner && !!catalogController && !!facts
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
        if (!activeBinding?.isCurrent() || !catalogController || !catalogProvisioner || busy) return;
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
        ...(receiptFacts ? buildManagedConfigurationReceipt({ launch: receiptFacts.launch, reviewedFacts: receiptFacts, providerTitle: title, controllerName, homeName, mark, localized,
            credentialPresentations: credentialAccounts.presentationsByKey, keepEditedBelow: Boolean(keepPolicy && defaultPolicy) })
            : { caption: t('managedMachines.receipt.yourNewMachine'), mark, name: draft?.name ?? title, spec: title, facts: [], cost: { kind: 'unpriced' as const, provider: title } }),
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
            effects: retentionCapabilities?.supportedIntents.filter((intent): intent is 'stop' | 'delete' => intent === 'stop' || intent === 'delete'),
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
    const summaryPrice = receipt.cost.kind === 'price' ? receipt.cost.prices[0] : undefined;
    const selectedTitle = draft?.selected ? localized(provisioner?.contribution.pluginId ?? '', draft.selected.title) : title;
    const summaryLabel = summaryPrice?.label ? localized(provisioner?.contribution.pluginId ?? '', summaryPrice.label) : null;
    // The bar names the rate it shows, then the same size, place and Keep facts as the receipt.
    const summaryFacts = receiptFacts ? describeManagedConfigurationSummary(receiptFacts,
        value => localized(receiptFacts.launch.provider.pluginId, value)) : null;
    const summarySpec = [summaryLabel, summaryFacts ?? selectedTitle].filter(Boolean).join(' · ');
    if (props.presetId && (teamDenied || presetQuery.state.error && isMachinePresetAccessLost(presetQuery.state.error)))
        return <SurfaceStateCard kind="denied" title={t('machinePresets.accessLost')} testID="managed-config.error"
            action={{ label: t('managedMachines.actions.tryAgain'), onPress: retry }} />;
    if (!provisioner) return <>
        {creationDisabledNotice}
        <ItemGroup title={t('managedMachines.config.managedFrom')} action={scope.chip} surface="none">
            <SurfaceStateCard kind={catalog.loading ? 'loading' : catalog.error ? 'error' : 'empty'} size="line"
                title={t(catalog.loading ? 'managedMachines.providers.loading' : 'managedMachines.providers.unavailable')}
                diagnosticCode={catalog.error} testID="managed-config.catalog" />
        </ItemGroup>
    </>;
    // Choices the provider returned without a native size, image, place or duration (those have their own sections).
    const otherChoices = draft ? draft.choices.filter(choice => !choice.nativeFacts?.size && !choice.nativeFacts?.image
        && !choice.nativeFacts?.location && !choice.nativeFacts?.duration) : [];
    const retainedChoice = draft?.selected && !draft.choices.some(choice => choice.id === draft.selected?.id && pluginJsonValuesEqual(choice.launch, draft.selected?.launch))
        ? draft.selected : undefined;
    const repairs = draft?.check?.prerequisites?.filter(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction) ?? [];
    const choiceState = !draft ? null : facts?.optionStatus === 'unavailable' ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.options.unavailable')} />
        : draft.optionStatus === 'loading' ? <SurfaceStateCard kind="loading" size="line" title={t('managedMachines.options.loading', { provider: title })} />
        : draft.optionStatus === 'current' && draft.choices.length === 0 ? <SurfaceStateCard kind="empty" size="line" title={t('managedMachines.options.empty', { provider: title })} />
        : draft.check?.available === false ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.providers.unavailable')} />
        : null;
    const kindTitle = presentation.kindTitle;
    const pageTitle = props.presetOnly || !kindTitle ? title : t('managedMachines.config.newKind', { provider: title, kind: kindTitle });
    // Unpriced, the bar's value stays short; the sentence belongs to the receipt.
    const summaryValue = summaryPrice ? formatProviderAmount(summaryPrice) : receiptFacts?.billing.location === 'local' ? t('managedMachines.price.noBill') : '—';
    const limitChoices = [...new Set([...LIMIT_CHOICES, ...(limit ? [limit] : [])])].sort((left, right) => left - right);
    return <ManagedMachineConfigurator title={pageTitle} description={props.presetOnly ? t('machinePresets.futureOnly') : compact ? undefined : t('managedMachines.config.description')} mark={mark}
        actions={scope.chip}
        compact={compact} testID="managed-config" receipt={receipt} summary={{ value: summaryValue,
            unit: summaryPrice ? formatPriceUnit(summaryPrice.unit) : '', spec: summarySpec }}>
        {approval.approvalId ? <AttentionBanner title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {creationDisabledNotice}
        {draft && credentialFields.length ? <ItemGroup title={t('managedMachines.receipt.account')}>
            <ActionInputFields fields={credentialFields} input={credentialInput}
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
                }} />
        </ItemGroup> : null}
        {draft && !credentialsReady ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.credential.required')}
            testID="managed-config.credential-required" /> : null}
        {draft && recipeFields.length ? <ItemGroup title={t('managedMachines.detail.recipeTitle')}>
            <ActionInputFields fields={recipeFields} input={fieldInput} editable={!!catalogProvisioner && !!catalogController && !busy && (!preset || props.presetOnly === true)}
                busy={busy} resolveFieldOptions={fieldOptions.resolveOptions} resolveFieldTestID={field => `managed-config.field:${field.path}`}
                onPatch={patch => setDraft(current => current ? setManagedConfiguratorOptionsSelectors(current, { ...fieldInput, ...patch }) : current)} />
            {selectors === null ? <SurfaceStateCard kind="warning" size="line" title={t('managedMachines.options.unavailable')} diagnosticCode="invalid_parameters" /> : null}
        </ItemGroup> : null}
        {draft && (otherChoices.length || retainedChoice || choiceState || repairs.length) ? <ItemGroup title={otherChoices.length || retainedChoice ? t('managedMachines.config.otherChoices') : undefined}>
            {otherChoices.map(choice => <Item key={choice.id} testID={`managed-config.choice:${choice.id}`} title={localized(provisioner.contribution.pluginId, choice.title)}
                selected={choice.id === draft.selected?.id && pluginJsonValuesEqual(choice.launch, draft.selected?.launch)} showChevron={false} disabled={!catalogProvisioner || !catalogController || busy || choice.available === false || !!preset && !props.presetOnly}
                onPress={() => setDraft(current => current ? selectManagedConfiguratorChoice(current, choice.id) : current)} />)}
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
            <ManagedFieldRow testID="managed-config.limit" row={{ title: t('machinePresets.atMost'), subtitle: limit ? t('machinePresets.limitWaits') : undefined,
                choices: [{ id: 'none', title: t('machinePresets.noLimit') }, ...limitChoices.map(value => ({ id: String(value), title: String(value) })),
                    { id: OTHER_LIMIT, title: t('machinePresets.otherLimit') }],
                value: limit ? String(limit) : 'none', disabled: busy,
                onChange: async id => {
                    if (id === 'none') { setLimit(undefined); return; }
                    if (id !== OTHER_LIMIT) { setLimit(Number(id)); return; }
                    const value = await Modal.prompt(t('machinePresets.runningAtOnce'), t('machinePresets.limitHelp'), { defaultValue: limit ? String(limit) : '', inputType: 'numeric' });
                    if (value !== null && activeBinding?.isCurrent()) { const parsed = Number(value); if (!value.trim()) setLimit(undefined); else if (Number.isSafeInteger(parsed) && parsed > 0) setLimit(parsed); }
                } }} />
        </ItemGroup> : null}
        {error ? <SurfaceStateCard kind="error" title={error === 'conflict' ? t('machinePresets.conflict') : t('managedMachines.options.error')}
            testID="managed-config.error" action={{ label: t('managedMachines.actions.tryAgain'), onPress: retry }} /> : null}
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
    onChange: (dimension: 'size' | 'image' | 'location', id: string) => void;
}>) {
    const { draft } = props;
    const pluginId = draft.provisioner.contribution.pluginId;
    const selected = managedConfiguratorDimensionSelection(draft);
    const unavailable = (available: boolean) => !available || props.disabled ? t('managedMachines.options.unavailable') : undefined;
    const sizes = managedConfiguratorDimensionChoices(draft, 'size').flatMap(({ choice, available, selectable }) => {
        const size = choice.nativeFacts?.size;
        if (!size) return [];
        const hourly = choice.prices?.find(price => price.unit === 'hour');
        const monthly = choice.prices?.find(price => price.unit === 'month');
        return [{ id: size.id, name: props.localized(pluginId, size.title), cpu: size.cpuCores === undefined ? '' : String(size.cpuCores),
            memory: size.memoryBytes === undefined ? '' : formatByteCapacity(size.memoryBytes), disk: size.diskBytes === undefined ? '' : formatByteCapacity(size.diskBytes),
            spec: props.localized(pluginId, size.title), ...(hourly ? { hourly: formatProviderAmount(hourly) } : {}),
            ...(monthly ? { monthly: formatProviderAmount(monthly) } : {}),
            headroom: draft.provisioner.descriptor.billing.location === 'local' ? describeLocalHeadroom(size, draft.check?.localResources) : undefined,
            unavailableReason: unavailable(available), selectable: selectable && !props.disabled }];
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
        return image ? [{ id: image.id, name: props.localized(pluginId, image.title),
            ...(preview ? { preview: <ManagedImagePreview source={preview}
                accessibilityLabel={image.preview?.accessibilityLabel ? props.localized(pluginId, image.preview.accessibilityLabel) : undefined} /> } : {}),
            description: unavailable(available) ?? (image.description ? props.localized(pluginId, image.description) : ''), unavailableReason: unavailable(available),
            selectable: selectable && !props.disabled }] : [];
    });
    const locations = managedConfiguratorDimensionChoices(draft, 'location').flatMap(({ choice, available, selectable }) => {
        const location = choice.nativeFacts?.location;
        // The country comes only from the provider's own ISO code, named in the reader's language.
        return location ? [{ id: location.id, city: props.localized(pluginId, location.title), countryCode: location.countryCode,
            country: countryName(location.countryCode, getPreferredLanguage()), unavailableReason: unavailable(available), selectable: selectable && !props.disabled }] : [];
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
            description={t('managedMachines.config.locationDescription')}
            onChange={id => props.onChange('location', id)} testID="managed-config.locations" /> : null}
    </>;
}
