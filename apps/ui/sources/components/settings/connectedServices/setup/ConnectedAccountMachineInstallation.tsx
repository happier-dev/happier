import * as React from 'react';
import { View } from 'react-native';
import type { PluginConnectedAccountMachineSetupV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ActionOperationRows } from '@/components/inbox/actionOperations/ActionOperationLedger';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useMachineNetworkFacts } from '@/components/machines/security/network/useMachineNetworkFacts';
import { useMachineSetup } from '@/components/machines/setup/useMachineSetup';
import { useMachineSetupRecipeOptions } from '@/components/store/catalog/storeSoftware';
import { MachineSetupPlanReview, MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { MachineSetupRecipeInputs } from '@/components/settings/machines/managed/MachineSetupRecipeInputs';
import { readMachineSetupRecipeInputState } from '@/components/settings/machines/managed/machineSetupRecipeInputsModel';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';

import { createConnectedAccountMachineSetupDraft, prefillConnectedAccountMachineSetupDraft, resolveAfterApplyConfiguration } from './connectedAccountMachineSetup';

/** A declared installation uses Machine Setup's existing review, approval and operation lifecycle. */
export function ConnectedAccountMachineInstallation(props: Readonly<{
    declaration: PluginConnectedAccountMachineSetupV1;
    serverId: string;
    machineId: string;
    machineName: string;
    online: boolean | null;
    localize: (value: PluginConnectedAccountMachineSetupV1['title']) => string;
    onReady: (configuration: Record<string, PluginJsonValueV2>) => void;
    onCancel?: () => void;
}>) {
    const presented = useLayoutPresentationActive();
    const canManage = useServerScopedMachine(props.serverId, props.machineId, canManageMachine);
    const scope = useServerCredentialAccountScopeBinding(props.serverId).binding?.scope ?? null;
    const network = useMachineNetworkFacts({ serverId: props.serverId, machineId: props.machineId,
        enabled: presented && Boolean(props.machineId), scope });
    const projection = useAppShellPluginUiDeclarationProjection();
    const setup = useMachineSetup({ serverId: props.serverId, machineId: props.machineId,
        active: presented && Boolean(props.machineId), online: props.online, canCheck: canManage });
    const [draft, setDraft] = React.useState(() => createConnectedAccountMachineSetupDraft(props.declaration, network.observation));
    const draftEdited = React.useRef(false);
    const reviewedDraft = React.useRef<MachineSetupV1 | null>(null);
    const deliveredOperation = React.useRef<string | null>(null);
    const ready = useEventCallback(props.onReady);
    React.useEffect(() => {
        if (draftEdited.current || setup.review || setup.operationId || setup.pending) return;
        setDraft(current => prefillConnectedAccountMachineSetupDraft(props.declaration, current, network.observation));
    }, [network.observation, props.declaration, setup.review, setup.operationId, setup.pending]);
    const operation = setup.operation;
    React.useEffect(() => {
        if (operation?.snapshot.state !== 'succeeded' || !reviewedDraft.current
            || deliveredOperation.current === operation.snapshot.operationId) return;
        deliveredOperation.current = operation.snapshot.operationId;
        ready(resolveAfterApplyConfiguration(props.declaration, reviewedDraft.current));
    }, [operation, props.declaration, ready]);
    const nameOf = React.useCallback(() => props.machineName, [props.machineName]);
    const inputState = readMachineSetupRecipeInputState(draft, projection);
    const offerTarget = React.useMemo(() => scope ? { scope, machine: null } : null, [scope]);
    // A pinned recipe bypasses the picker, but borrows its incumbent cold declaration demand.
    const recipeOptions = useMachineSetupRecipeOptions(offerTarget, { presented: presented && inputState.rows.length === 0 });
    const recipeCatalogState = inputState.rows.length === 0 ? recipeOptions.state : null;
    const loadingRecipe = recipeCatalogState?.status === 'loading';
    const unavailableRecipe = recipeCatalogState !== null && recipeCatalogState.status !== 'loading';
    const editable = Boolean(props.machineId) && canManage && props.online !== false && !loadingRecipe && !unavailableRecipe;
    const failure = setup.failure ? presentActionFailureOutcome(setup.failure.failure ?? {
        ok: false, errorCode: setup.failure.code, error: setup.failure.code,
    }) : null;
    return <View testID="connected-account-machine-setup">
        <ItemGroup surface="none" title={props.localize(props.declaration.title)}
            description={t('connectedServicesSettings.setupInstallHelp')}>{null}</ItemGroup>
        {setup.operationId ? <ItemGroup title={t('machinePresets.setup.tab.applying')}>
            {operation ? <ActionOperationRows operations={[operation]} onOpenOperation={item => openActionOperationDetail({
                serverId: item.serverId, operationId: item.snapshot.operationId,
            })} /> : <Item title={t('machinePresets.setup.tab.started', { machine: props.machineName })}
                subtitle={t('machinePresets.setup.tab.startedHelp')}
                onPress={() => openActionOperationDetail({ serverId: props.serverId, operationId: setup.operationId! })} />}
            {operation && isActionOperationTerminal(operation.snapshot.state) && operation.snapshot.state !== 'succeeded'
                ? <Item testID="connected-account-machine-setup:retry" title={t('common.retry')}
                    onPress={setup.dismissOperation} /> : null}
        </ItemGroup> : <>
            {failure ? <SurfaceStateCard testID="connected-account-machine-setup:error" size="line" kind="error"
                title={t(setup.failure?.during === 'apply' ? 'machinePresets.setup.applyFailed' : 'machinePresets.setup.review.planFailed', { machine: props.machineName })}
                reason={failure.reason ?? undefined} diagnosticCode={failure.code ?? setup.failure?.code}
                diagnosticDetail={failure.technicalDetails.map(line => `${line.label}: ${line.value}`).join('\n')} /> : null}
            {setup.review ? <>
                {setup.review.prepared ? <MachineSetupPlanReview testID="connected-account-machine-setup:plan"
                    prepared={setup.review.prepared} nameOf={nameOf} disabled={setup.pending !== null} /> : null}
                {setup.approvalId ? <AttentionBanner tone="neutral" title={t('approvals.title')} description={t('approvals.status.open')} /> : null}
                <MachineSetupReviewFooter prepared={setup.review.prepared} nameOf={nameOf}
                    onCancel={setup.cancelReview} cancelTestID="connected-account-machine-setup:back"
                    primary={setup.approvalId ? undefined : { testID: 'connected-account-machine-setup:apply',
                        label: t('machinePresets.setup.applyRun', { machine: props.machineName }),
                        disabled: setup.pending !== null || !setup.review.prepared, loading: setup.pending === 'apply',
                        onPress: () => { void setup.apply(); } }} />
            </> : <>
                {!props.machineId ? <SurfaceStateCard size="line" kind="unavailable"
                    title={t('connectedServicesSettings.setupInstallChooseMachine')} />
                    : !canManage ? <SurfaceStateCard size="line" kind="unavailable" title={t('machinePresets.setup.tab.readOnly')} />
                    : props.online === false ? <SurfaceStateCard size="line" kind="unavailable"
                        title={t('machinePresets.setup.tab.offline', { machine: props.machineName })} />
                    : loadingRecipe ? <SurfaceStateCard size="line" kind="loading"
                        title={t('connectedServicesSettings.setupInstallLoading')} />
                    : unavailableRecipe ? <SurfaceStateCard size="line" kind="unavailable"
                        title={t('connectedServicesSettings.setupInstallUnavailable')} diagnosticCode={recipeCatalogState?.errorCode}
                        action={{ label: t('common.retry'), onPress: recipeOptions.refresh }} />
                    : <MachineSetupRecipeInputs setup={draft} projection={projection} scope={scope}
                        onChange={next => { draftEdited.current = true; setDraft(next); }} testID="connected-account-machine-setup:inputs" />}
                <ItemGroup surface="none"><Item testID="connected-account-machine-setup:skip"
                    title={t('connectedServicesSettings.setupExistingDeployment')} onPress={() => ready({})} />
                </ItemGroup>
                <MachineSetupReviewFooter onCancel={() => props.onCancel?.()} cancelTestID="connected-account-machine-setup:cancel"
                    primary={{ testID: 'connected-account-machine-setup:review', label: t('connectedServicesSettings.setupInstallReview'),
                        disabled: !editable || !inputState.valid || setup.pending !== null, loading: setup.pending === 'review',
                        onPress: () => {
                            reviewedDraft.current = draft;
                            void setup.prepare({ kind: 'sources', sources: [{ kind: 'direct', setup: draft }] });
                        } }} />
            </>}
        </>}
    </View>;
}
