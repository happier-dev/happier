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
import { resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
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
import { t } from '@/text';
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
import { ManagedMachineConfigurator } from './ManagedMachineConfigurator';
import { ManagedMachineStateRow } from './ManagedMachineStateRow';
import { buildManagedConfigurationReceipt, managedCredentialReceiptTargets } from './managedConfigurationPresentation';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions, selectManagedConfiguratorChoice,
    managedConfiguratorFacts, managedConfiguratorAcquireInput, managedConfiguratorOptionsSelectors, setManagedConfiguratorOptionsSelectors, setManagedConfiguratorCredentials, managedConfiguratorCredentialSelections,
    type ManagedConfiguratorDraft } from './managedConfiguratorModel';
import { describeRetention, retentionCategoryTitle } from './managedRetentionPresentation';
import { formatProviderAmount, formatPriceUnit } from './managedMachineDisplay';
import { ManagedSizeTable, ManagedImageTiles, ManagedLocationGroup } from './ManagedChoiceSections';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { managedConfiguratorDimensionChoices, managedConfiguratorDimensionSelection, selectManagedConfiguratorDimension } from './managedConfiguratorModel';
import { createManagedMachineSelectionDraft, type ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRetentionDuration } from './managedRetentionPresentation';

export type ManagedMachineConfigurationViewProps = Readonly<{
    serverId: string; provisioner: string; presetId?: string; presetOnly?: boolean; initialController?: ManagedControllerV1;
    /** Composer review commits local intent; only its explicit Send admits an acquisition. */
    onUse?: (draft: ManagedMachineSelectionDraft) => void;
}>;
export function ManagedMachineConfigurationView(props: ManagedMachineConfigurationViewProps) {
    return <ManagedMachineConfigurationViewBody key={JSON.stringify([props.serverId, props.provisioner, props.presetId])} {...props} />;
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
    const [selectedController, setSelectedController] = React.useState(props.initialController);
    const requestedController = draft?.controller ?? selectedController ?? preset?.controller;
    const catalogController = requestedController && machines.some(machine => machine.id === requestedController.machineId
        && machine.installationId === requestedController.installationId) ? requestedController : undefined;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, catalogController);
    const accountSettings = useManagedMachineAccountSettings(catalog.binding ?? undefined);
    const [teamId, setTeamId] = React.useState('');
    const [limit, setLimit] = React.useState<number | undefined>();
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [saved, setSaved] = React.useState(false);
    const [readRevision, retry] = React.useReducer(value => value + 1, 0);
    const approval = useActionApprovalContinuation({ serverId: props.serverId,
        scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId, props.provisioner]), onExecuted: () => {} });
    approvalHandler.current = approval.requestApproval;
    const mutationAbort = React.useRef<AbortController | null>(null);
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
    React.useEffect(() => {
        if (!catalogController || props.presetId || !provisioner) return;
        const initial = catalogController;
        if (!machines.some(machine => machine.id === initial.machineId && machine.installationId === initial.installationId)) return;
        setDraft(current => current ?? createManagedConfiguratorDraft({ provisioner, controller: initial, name: title }));
    }, [catalogController, props.presetId, provisioner, machines, title]);
    React.useEffect(() => {
        if (!preset || !provisioner) return;
        setDraft(current => current ?? { ...createManagedConfiguratorDraft({ provisioner, controller: catalogController ?? preset.controller, name: preset.recipe.name,
            credentials: preset.recipe.credentials,
            preset: { id: preset.id, revision: preset.revision, name: preset.name, retention: preset.retention, wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage } }),
            selected: { id: `preset:${preset.id}`, title: preset.name, launch: preset.recipe.choices } });
    }, [preset, provisioner, catalogController]);

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
            mutationAbort.current?.abort(); reviewed.current = null; loadedPreset.current = null; setDraft(null); setPreset(null); setSelectedController(undefined); setBusy(false); setError(null);
        });
        return () => { retirement.dispose(); mutationAbort.current?.abort(); };
    }, [catalog.binding]);

    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding || !catalog.homeId || !presetClient || !props.presetId) return;
        const abort = new AbortController();
        const apply = (value: { kind: 'found'; preset: ManagedMachinePresetV1 } | { kind: 'refused'; code: string }) => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            if (value.kind === 'refused') { setError(value.code); return; }
            const row = value.preset;
            if (buildQualifiedPluginContributionKey(row.recipe.provider) !== props.provisioner) { setError('invalid_parameters'); return; }
            if (!loadedPreset.current) {
                setLimit(row.simultaneousLimit?.maximum); setTeamId(row.owner.kind === 'team' ? row.owner.teamId : '');
            }
            loadedPreset.current = row;
            setPreset(row);
            // Explicit conflict review advances the basis without replacing the person's edited recipe or policy.
            setDraft(current => current?.preset?.id === row.id ? { ...current,
                preset: { ...current.preset, revision: row.revision, name: row.name } } : current);
        };
        void presetClient.execute('machines.presets.get', { homeId: catalog.homeId, id: props.presetId }, {
            signal: abort.signal, onApprovalPending, onApprovalSucceeded: apply, onApprovalFailed: code => { if (!abort.signal.aborted) setError(code); },
        }).then(result => { if (result.kind === 'succeeded') apply(result.value); else if (result.kind === 'failed' && !abort.signal.aborted) setError(result.code); })
            .catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setError('unavailable'); });
        return () => abort.abort();
    }, [catalog.binding, catalog.homeId, presetClient, props.presetId, props.provisioner, readRevision]);

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
    const defaultPolicy = provisioner ? resolveMachineRetentionPolicyV1({ billing: provisioner.descriptor.billing,
        nativeCapabilities: provisioner.descriptor.retention, presetOverride: props.presetOnly ? undefined : draft?.preset, categoryPreferences: accountSettings.settings?.machineRetentionDefaultsV1 }) : null;
    const finiteOnly = provisioner?.descriptor.retention.finiteOnly === true;
    const nativeDurationField = finiteOnly && provisioner?.descriptor.nativeDurationInput
        ? fields.find(field => field.path === provisioner.descriptor.nativeDurationInput?.path) : undefined;
    const recipeFields = fields.filter(field => field !== nativeDurationField);
    const keepPolicy = facts ?? (finiteOnly ? defaultPolicy : null);
    const nativeExpiry = provisioner?.descriptor.retention.nativeExpiry;
    const receiptController = receiptFacts?.controller ?? controller;
    const controllerName = getMachineDisplayName(machines.find(machine => machine.id === receiptController?.machineId
        && machine.installationId === receiptController?.installationId)) ?? t('common.unknown');
    const activeBinding = catalog.binding;
    const mayCreate = !!catalogProvisioner && !!catalogController && !!facts && facts.optionStatus === 'current' && draft?.check?.available === true
        && credentialsReady
        && (!preset || preset.archivedAt === undefined) && accountSettings.settings?.managedMachineCreationEnabled === true && !!activeBinding?.isCurrent() && !busy;
    // A retained recipe can still be saved, but explicit field edits must satisfy the declared input schema.
    const maySave = !!catalogProvisioner && !!catalogController && !!facts
        && credentialsReady && (!credentialPurposes?.length || facts.optionStatus === 'current')
        && (draft?.optionsSelectors === undefined || selectors !== null && facts.optionStatus === 'current') && !!activeBinding?.isCurrent() && teamWritable && !busy;
    const completedSave = (value: PresetMutationResultV1) => {
        if (!activeBinding?.isCurrent()) return;
        setBusy(false);
        if (value.kind === 'saved') { setSaved(true); setError(null); if (props.presetOnly) router.replace(`/settings/machines/presets/${encodeURIComponent(value.preset.id)}?serverId=${encodeURIComponent(activeBinding.serverId)}` as never); }
        else setError(value.kind === 'conflict' ? 'conflict' : value.code);
    };
    const failed = (code: string) => { if (activeBinding?.isCurrent()) { setBusy(false); setError(code); } };
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
                retention: draft?.override?.retention ?? draft?.preset?.retention ?? null,
                wakeOnAcceptedMessage: draft?.override?.wakeOnAcceptedMessage ?? draft?.preset?.wakeOnAcceptedMessage ?? null,
                simultaneousLimit: limit ? { maximum: limit } : null },
        }, callbacks) : await presetClient.execute('machines.presets.create', {
            homeId: catalog.homeId, id: randomUUID(), name: facts.launch.name, recipe: facts.launch,
            owner: teamId ? { kind: 'team', teamId } : { kind: 'account', accountId: activeBinding.accountId }, controller: facts.controller,
            ...(draft?.override?.retention ?? draft?.preset?.retention ? { retention: draft?.override?.retention ?? draft?.preset?.retention } : {}),
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
    const receipt: ManagedReceiptModel = {
        ...(receiptFacts ? buildManagedConfigurationReceipt({ launch: receiptFacts.launch, reviewedFacts: receiptFacts, providerTitle: title, controllerName, homeName, mark, localized,
            credentialPresentations: credentialAccounts.presentationsByKey })
            : { caption: t('managedMachines.receipt.yourNewMachine'), mark, name: draft?.name ?? title, spec: title, facts: [], cost: { kind: 'unpriced' as const, provider: title } }),
        onRename: !preset || props.presetOnly ? () => { void rename(); } : undefined,
        keep: keepPolicy && defaultPolicy ? { policy: keepPolicy, defaultPolicy, inherited: !draft?.override && (!props.presetOnly || !draft?.preset?.retention && draft?.preset?.wakeOnAcceptedMessage === undefined), categoryLabel: retentionCategoryTitle(defaultPolicy.category),
            finiteOnly,
            ...(finiteOnly && draft && provisioner ? { nativeDuration: {
                value: managedConfiguratorDimensionSelection(draft).duration ?? null,
                choices: managedConfiguratorDimensionChoices(draft, 'duration').flatMap(({ choice, available }) => {
                    const duration = choice.nativeFacts?.duration;
                    return duration ? [{ id: duration.id, title: localized(provisioner.contribution.pluginId, duration.title),
                        unavailableReason: !available || busy || !!preset && !props.presetOnly ? t('managedMachines.options.unavailable') : undefined }] : [];
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
            effects: provisioner?.descriptor.retention.supportedIntents.filter((intent): intent is 'stop' | 'delete' => intent === 'stop' || intent === 'delete'),
            canWake: provisioner?.descriptor.retention.supportedIntents.includes('start'), consequence: describeRetention,
            onChange: policy => setDraft(current => current ? { ...current, override: policy } : current),
            onReset: () => setDraft(current => current ? { ...current, override: undefined,
                preset: props.presetOnly && current.preset ? { id: current.preset.id, revision: current.preset.revision, name: current.preset.name } : current.preset } : current), disabled: !catalogController || !catalogProvisioner || busy } : undefined,
        primary: { label: props.presetOnly ? t('common.save') : props.onUse ? t('common.use') : t('managedMachines.receipt.createKind', { kind: provisioner?.descriptor.resourceKind ?? '' }),
            onPress: () => { if (props.presetOnly) void save(); else if (props.onUse) commitUse(); else void create(); },
            disabled: props.presetOnly ? !maySave : !mayCreate, loading: busy, testID: props.onUse && !props.presetOnly ? 'managed-config.use' : 'managed-config.create' },
        secondary: !props.presetOnly ? [{ label: t('managedMachines.receipt.saveAsPreset'), onPress: () => { void save(); }, disabled: !maySave, testID: 'managed-config.save-preset', tone: 'text' }] : undefined,
    };

    const creationDisabledNotice = accountSettings.settings?.managedMachineCreationEnabled === false && !props.presetOnly
        ? <ManagedMachineStateRow name={title || t('managedMachines.add.createPath')} mark={mark} state={{ kind: 'creationDisabled' }}
            handlers={{}} testID="managed-config.creation-disabled" /> : null;
    const summaryPrice = receipt.cost.kind === 'price' ? receipt.cost.prices[0] : undefined;
    const selectedTitle = draft?.selected ? localized(provisioner?.contribution.pluginId ?? '', draft.selected.title) : title;
    const summaryLabel = summaryPrice?.label ? localized(provisioner?.contribution.pluginId ?? '', summaryPrice.label) : null;
    if (!provisioner) return <>
        {creationDisabledNotice ? <ItemGroup>{creationDisabledNotice}</ItemGroup> : null}
        <ItemGroup title={t('managedMachines.config.managedFrom')}>
            {machines.filter(machine => !!machine.installationId).map(machine => <Item key={machine.id} testID={`managed-config.controller:${machine.id}`}
                title={getMachineDisplayName(machine) ?? machine.id} selected={machine.id === controller?.machineId} showChevron={false}
                onPress={() => { if (machine.installationId) setSelectedController({ machineId: machine.id, installationId: machine.installationId }); }} />)}
        </ItemGroup>
        <SurfaceStateCard kind={catalog.loading ? 'loading' : catalog.error ? 'error' : 'empty'} title={t(catalog.loading ? 'managedMachines.providers.loading' : 'managedMachines.providers.unavailable')}
            diagnosticCode={catalog.error} testID="managed-config.catalog" />
    </>;
    return <ManagedMachineConfigurator title={title} description={props.presetOnly ? t('machinePresets.futureOnly') : t('managedMachines.add.createPath')} mark={mark}
        compact={compact} testID="managed-config" receipt={receipt} summary={{ value: summaryPrice ? formatProviderAmount(summaryPrice) : receiptFacts?.billing.location === 'local' ? t('managedMachines.price.noBill') : t('managedMachines.price.unavailable', { provider: title }),
            unit: summaryPrice ? formatPriceUnit(summaryPrice.unit) : '', spec: summaryLabel ? `${summaryLabel} · ${selectedTitle}` : selectedTitle }}>
        <ItemGroup title={t('managedMachines.config.managedFrom')}>
            {machines.filter(machine => !!machine.installationId).map(machine => <Item key={machine.id} testID={`managed-config.controller:${machine.id}`}
                title={getMachineDisplayName(machine) ?? machine.id} selected={machine.id === controller?.machineId} showChevron={false} disabled={busy}
                onPress={() => { if (!machine.installationId) return; setSelectedController({ machineId: machine.id, installationId: machine.installationId }); setDraft(current => current ? { ...current, controller: { machineId: machine.id, installationId: machine.installationId }, check: undefined, optionStatus: 'loading' }
                    : createManagedConfiguratorDraft({ provisioner, controller: { machineId: machine.id, installationId: machine.installationId }, name: title })); }} />)}
        </ItemGroup>
        {approval.approvalId ? <AttentionBanner title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {creationDisabledNotice ? <ItemGroup>{creationDisabledNotice}</ItemGroup> : null}
        {draft && credentialFields.length ? <ItemGroup title={t('connectedServices.title')}>
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
        {draft ? <ItemGroup title={t('managedMachines.detail.recipeTitle')}>
            {draft.choices.filter(choice => !choice.nativeFacts?.size && !choice.nativeFacts?.image && !choice.nativeFacts?.location && !choice.nativeFacts?.duration).map(choice => <Item key={choice.id} testID={`managed-config.choice:${choice.id}`} title={localized(provisioner.contribution.pluginId, choice.title)}
                selected={choice.id === draft.selected?.id && pluginJsonValuesEqual(choice.launch, draft.selected?.launch)} showChevron={false} disabled={!catalogProvisioner || !catalogController || busy || choice.available === false || !!preset && !props.presetOnly}
                onPress={() => setDraft(current => current ? selectManagedConfiguratorChoice(current, choice.id) : current)} />)}
            {draft.selected && !draft.choices.some(choice => choice.id === draft.selected?.id && pluginJsonValuesEqual(choice.launch, draft.selected?.launch))
                ? <Item testID="managed-config.retained-choice" mode="info" title={localized(provisioner.contribution.pluginId, draft.selected.title)}
                    subtitle={t('managedMachines.options.unavailable')} selected showChevron={false} /> : null}
            {facts?.optionStatus === 'unavailable' ? <SurfaceStateCard kind="warning" title={t('managedMachines.options.unavailable')} /> : null}
            {draft.optionStatus === 'loading' ? <SurfaceStateCard kind="loading" title={t('managedMachines.options.loading', { provider: title })} /> : null}
            {draft.optionStatus === 'current' && draft.choices.length === 0 ? <SurfaceStateCard kind="empty" title={t('managedMachines.options.empty', { provider: title })} /> : null}
            {draft.check?.available === false ? <SurfaceStateCard kind="warning" title={t('managedMachines.providers.unavailable')} /> : null}
            {draft.check?.prerequisites?.filter(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction).map(prerequisite => {
                const id = typeof prerequisite.requirement.id === 'string' ? prerequisite.requirement.id
                    : buildQualifiedPluginContributionKey(prerequisite.requirement.id);
                return <Item key={`${prerequisite.requirement.kind}:${id}`}
                    testID={`managed-config.repair:${prerequisite.requirement.kind}:${id}`}
                    title={t('managedMachines.add.action.setUp')} subtitle={prerequisite.reason ?? id}
                    disabled={!catalogController || !catalogProvisioner || busy} onPress={() => { if (prerequisite.repairAction) void repair(prerequisite.repairAction); }} />;
            })}
        </ItemGroup> : null}
        {draft ? <ManagedConfiguratorNativeChoices draft={draft} localized={localized} compact={compact} disabled={!catalogProvisioner || !catalogController || busy || !!preset && !props.presetOnly}
            onChange={(dimension, id) => setDraft(current => current ? selectManagedConfiguratorDimension(current, dimension, id) : current)} /> : null}
        {draft ? <ItemGroup title={t('machinePresets.audience')}>
            <Item title={t('machinePresets.ownerPersonal')} selected={!teamId} disabled={!!preset || busy} onPress={() => setTeamId('')} />
            {teams.rows.map(row => <Item key={row.team.id} title={row.team.name} selected={row.team.id === teamId}
                disabled={!!preset || busy || !row.team.capabilities.manageSettings || teams.stale} onPress={() => setTeamId(row.team.id)} />)}
            {teams.hasMore ? <Item title={t('common.next')} onPress={teams.loadMore} /> : null}
            <Item title={t('machinePresets.runningAtOnce')} subtitle={limit ? String(limit) : t('machinePresets.limitNone')} onPress={async () => {
                const value = await Modal.prompt(t('machinePresets.runningAtOnce'), t('machinePresets.limitHelp'), { defaultValue: limit ? String(limit) : '', inputType: 'numeric' });
                if (value !== null && activeBinding?.isCurrent()) { const parsed = Number(value); if (!value.trim()) setLimit(undefined); else if (Number.isSafeInteger(parsed) && parsed > 0) setLimit(parsed); }
            }} />
        </ItemGroup> : null}
        {error ? <SurfaceStateCard kind="error" title={error === 'conflict' ? t('machinePresets.conflict') : t('managedMachines.options.error')}
            testID="managed-config.error" action={{ label: t('managedMachines.actions.tryAgain'), onPress: retry }} /> : null}
        {saved ? <SurfaceStateCard kind="success" title={t('machinePresets.title')} /> : null}
    </ManagedMachineConfigurator>;
}

/** The labelled dimensions select complete, provider-returned variants through the draft owner. */
function ManagedConfiguratorNativeChoices(props: Readonly<{
    draft: ManagedConfiguratorDraft;
    localized: ReturnType<typeof useManagedProvisionerPresentation>['localized'];
    compact: boolean; disabled: boolean;
    onChange: (dimension: 'size' | 'image' | 'location', id: string) => void;
}>) {
    const { draft } = props;
    const pluginId = draft.provisioner.contribution.pluginId;
    const selected = managedConfiguratorDimensionSelection(draft);
    const unavailable = (available: boolean) => !available || props.disabled ? t('managedMachines.options.unavailable') : undefined;
    const sizes = managedConfiguratorDimensionChoices(draft, 'size').flatMap(({ choice, available }) => {
        const size = choice.nativeFacts?.size;
        if (!size) return [];
        const hourly = choice.prices?.find(price => price.unit === 'hour');
        const monthly = choice.prices?.find(price => price.unit === 'month');
        return [{ id: size.id, name: props.localized(pluginId, size.title), cpu: size.cpuCores === undefined ? '' : String(size.cpuCores),
            memory: size.memoryBytes === undefined ? '' : formatByteSize(size.memoryBytes), disk: size.diskBytes === undefined ? '' : formatByteSize(size.diskBytes),
            spec: props.localized(pluginId, size.title), ...(hourly ? { hourly: formatProviderAmount(hourly) } : {}),
            ...(monthly ? { monthly: formatProviderAmount(monthly) } : {}), unavailableReason: unavailable(available) }];
    });
    const images = managedConfiguratorDimensionChoices(draft, 'image').flatMap(({ choice, available }) => {
        const image = choice.nativeFacts?.image;
        return image ? [{ id: image.id, name: props.localized(pluginId, image.title), description: unavailable(available) ?? '', unavailableReason: unavailable(available) }] : [];
    });
    const locations = managedConfiguratorDimensionChoices(draft, 'location').flatMap(({ choice, available }) => {
        const location = choice.nativeFacts?.location;
        return location ? [{ id: location.id, city: props.localized(pluginId, location.title), country: '', unavailableReason: unavailable(available) }] : [];
    });
    return <>
        {sizes.length ? <ItemGroup title={t('managedMachines.config.size')}><ManagedSizeTable sizes={sizes} value={selected.size ?? null}
            onChange={id => props.onChange('size', id)} compact={props.compact} testID="managed-config.sizes" /></ItemGroup> : null}
        {images.length ? <ItemGroup title={t('managedMachines.config.image')}><ManagedImageTiles images={images} value={selected.image ?? null}
            onChange={id => props.onChange('image', id)} testID="managed-config.images" /></ItemGroup> : null}
        {locations.length ? <ManagedLocationGroup locations={locations} value={selected.location ?? null} title={t('managedMachines.config.location')}
            onChange={id => props.onChange('location', id)} testID="managed-config.locations" /> : null}
    </>;
}
