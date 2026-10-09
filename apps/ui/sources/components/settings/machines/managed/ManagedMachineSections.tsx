import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineActionOutputSchemasV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useServerScopedMachine, useMachineListForServer } from '@/sync/domains/state/storage';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { ManagedReceiptColumns } from './ManagedReceiptPageLayout';
import { ManagedCreationScopeRuleSection } from './ManagedCreationScopeRuleSection';
import { ManagedMachineKeepControl, type ManagedMachineKeepControlProps } from './ManagedMachineKeepControl';
import { useLiveValue, useLiveValueChannel, type LiveValueChannel } from './liveValueChannel';
import { ManagedCreationProgress } from './ManagedCreationProgress';
import { ManagedMachineControllerSection, ManagedMachinePolicySection, ManagedMachineRecipeSection, ManagedControllerMoveList } from './ManagedMachineDetailSections';
import { buildManagedConfigurationReceipt, managedCredentialReceiptTargets, managedSizeDimensions } from './managedConfigurationPresentation';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import { describeRetention, formatRetentionDuration } from './managedRetentionPresentation';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { canRetryManagedInstallation, describeManagedCreation, managedCreationSetup } from './managedCreationPresentation';
import { useManagedMachineActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { publishActionOperationObservation, reconcileActionOperationsOnce } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { readManagedMachinePolicyParent, type ManagedMachinePolicyParent } from './managedMachinePolicyParent';
import { useManagedMachineInventory, type ManagedMachineInventoryEntry } from './useManagedMachineInventory';
import { ManagedMachineReadApprovalNotice } from './ManagedMachineReadApprovalNotice';
import { currentManagedMoveController, readManagedMachineMoveCandidates, type ManagedMachineMoveCandidate } from './managedMachineMoveCandidates';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';

const execute = createFrontDoorActionExecute();
type Execute = ReturnType<typeof createFrontDoorActionExecute>;
type SectionProps = Readonly<{
    machine: ManagedMachineV1;
    serverId: string;
    binding?: ServerCredentialAccountScopeBinding;
    current: boolean;
    executeAction: Execute;
    onChanged: () => void;
    onDenied: (code: string) => void;
}>;

/**
 * One mounted detail consumer for pre-enrollment and ordinary enrolled Machine pages (lab `m-detail`):
 * what blocks use, the creation scope rule, the live Keep it, the controller and the recipe on the
 * left, the immutable receipt beside them with Stop and Delete at its foot. A phone reads the same
 * sections with Keep it as a summary row, then the receipt.
 */
export function ManagedMachineSections(props: SectionProps) {
    const { machine } = props;
    const { theme } = useUnistyles();
    const router = useRouter();
    const layout = useHappierCollectionLayout();
    const compact = useDeviceType() === 'phone' || layout?.mode === 'stacked';
    const controller = useServerScopedMachine(props.serverId, machine.controller.machineId);
    const controllerMachines = useMachineListForServer(props.serverId);
    const controllerMachinesRef = React.useRef(controllerMachines);
    controllerMachinesRef.current = controllerMachines;
    const controllerName = getMachineDisplayName(controller) ?? t('common.unknown');
    const credentialTargets = React.useMemo(() => managedCredentialReceiptTargets(machine.launch), [machine.launch]);
    const credentialPresentation = useQualifiedConnectedAccountTargetPresentations({
        binding: props.binding ?? null, targets: credentialTargets,
    });
    const controllerPresence = controller ? describeMachinePresenceLine(controller) : null;
    const requiredController = controller?.installationId === machine.controller.installationId ? controller : null;
    const mark = <Icon name="desktop" color={theme.colors.text.secondary} />;
    const [pending, setPending] = React.useState<ManagedMachineActionIdV1 | null>(null);
    const pendingRef = React.useRef(false);
    const [error, setError] = React.useState<string | null>(null);
    const [deleteReview, setDeleteReview] = React.useState<Readonly<{ key: string; census: MachineReferenceCensusV1 }> | null>(null);
    const [moveReview, setMoveReview] = React.useState<Readonly<{ key: string; candidates: readonly ManagedMachineMoveCandidate[] }> | null>(null);
    const [moveLoading, setMoveLoading] = React.useState(false);
    const moveLoadingRef = React.useRef(false);
    const [removeReviewKey, setRemoveReviewKey] = React.useState<string | null>(null);
    const deleteReviewKey = JSON.stringify([props.serverId, props.binding?.accountId, props.binding?.revision,
        machine.id, machine.intentRevision, machine.controller, machine.resource]);
    const reviewedDependencies = deleteReview?.key === deleteReviewKey ? deleteReview.census : null;
    const interestRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        const interest = new AbortController();
        interestRef.current = interest;
        pendingRef.current = false;
        setPending(null);
        setError(null);
        setDeleteReview(null);
        setMoveReview(null);
        setRemoveReviewKey(null);
        moveLoadingRef.current = false;
        setMoveLoading(false);
        const retirement = props.binding?.onRetire(() => interest.abort());
        return () => {
            interest.abort();
            retirement?.dispose();
            if (interestRef.current === interest) interestRef.current = null;
        };
    }, [props.binding, machine.id]);
    const approval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([props.serverId, props.binding?.accountId, props.binding?.revision, machine.id]),
        serverId: props.serverId, onExecuted: () => {
            // Captured continuations consume their own results. Native writes
            // invalidate in complete; a safe read must not restart itself.
        },
    });
    const approvalRequestRef = React.useRef(approval.requestApproval);
    approvalRequestRef.current = approval.requestApproval;
    const [policyParent, setPolicyParent] = React.useState<ManagedMachinePolicyParent | null>(null);
    const [parentReadRevision, refreshPolicyParent] = React.useReducer(value => value + 1, 0);
    const policyController = requiredController && controllerPresence?.online ? machine.controller
        : controllerMachines?.map(row => currentManagedMoveController(row, machine.custodianAccountId)).find(row => row !== null)
            ?? (requiredController ? machine.controller : null);
    const parentReadKey = JSON.stringify([machine.homeId, machine.id, policyController, machine.launch.provider,
        machine.launch.schemaVersion, machine.launch.credentials, machine.preset?.id]);
    const parentControllerAvailable = policyController !== null;
    React.useEffect(() => {
        const binding = props.binding;
        setPolicyParent(null);
        if (!props.current || !binding?.isCurrent() || !policyController) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => { abort.abort(); setPolicyParent(null); });
        void readManagedMachinePolicyParent({ machine, controller: policyController, binding, signal: abort.signal,
            onApprovalPending: registration => approvalRequestRef.current(registration) }).then(result => {
                if (!abort.signal.aborted && binding.isCurrent() && result.kind === 'ready') setPolicyParent(result.parent);
            }).catch(() => { /* An unavailable parent cannot enable Reset; the live row remains readable. */ });
        return () => { abort.abort(); retirement.dispose(); };
    }, [props.binding, props.current, parentControllerAvailable, parentReadKey, parentReadRevision]);
    const policy = machine;
    const supportedIntents = policyParent?.capabilities.supportedIntents ?? machine.reviewedFacts?.retentionCapabilities.supportedIntents ?? [];
    const canManage = props.binding?.accountId === machine.custodianAccountId
        || (requiredController?.access?.role === 'manage' && requiredController.access.accessState === 'ready');
    const canMutate = props.current && props.binding?.isCurrent() === true && canManage && pending === null && !moveLoading && !approval.approvalPending;
    const bound = machine.allocation === 'bound' && Boolean(machine.resource);
    const operation = useManagedMachineActionOperation({ serverId: props.serverId, accountId: props.binding?.accountId ?? null,
        homeId: machine.homeId, machineId: machine.controller.machineId, managedId: machine.id, enrolledMachineId: machine.enrolledMachineId });
    const [operationReadRevision, refreshOperation] = React.useReducer(value => value + 1, 0);
    const currentControllerAvailable = requiredController !== null;
    React.useEffect(() => {
        const binding = props.binding;
        if (!props.current || !binding?.isCurrent()) return;
        let current = true;
        const retirement = binding.onRetire(() => { current = false; });
        const shouldContinue = () => current && binding.isCurrent();
        const machineIds = [...new Set([...(currentControllerAvailable ? [machine.controller.machineId] : []),
            ...(machine.enrolledMachineId ? [machine.enrolledMachineId] : [])])];
        for (const machineId of machineIds) {
            const scope = { serverId: props.serverId, accountId: binding.accountId, machineId };
            void reconcileActionOperationsOnce({ scope, shouldContinue, requireCurrentDomainFacts: true }).catch(() => {
                if (shouldContinue()) publishActionOperationObservation({ ...scope, observation: 'unavailable' });
            });
        }
        return () => { current = false; retirement.dispose(); };
    }, [props.binding, props.current, props.serverId, currentControllerAvailable, machine.id,
        machine.controller.machineId, machine.controller.installationId, machine.enrolledMachineId, operationReadRevision]);
    const powerIntents = supportedIntents.filter((intent): intent is 'start' | 'stop' | 'suspend' | 'resume' =>
        intent === 'start' || intent === 'stop' || intent === 'suspend' || intent === 'resume');

    const run = async (actionId: ManagedMachineActionIdV1, input: unknown, onSucceeded?: (result: unknown) => void) => {
        const binding = props.binding;
        const interest = interestRef.current;
        if (!binding?.isCurrent() || !props.current || pendingRef.current || !interest || interest.signal.aborted
            || (actionId !== 'machines.managed.inspect' && !canManage)) return;
        pendingRef.current = true;
        setPending(actionId);
        setError(null);
        let awaitingApproval = false;
        const release = () => {
            if (!binding.isCurrent() || interest.signal.aborted) return;
            pendingRef.current = false;
            setPending(null);
        };
        const fail = (code: string) => {
            if (!binding.isCurrent() || interest.signal.aborted) return;
            setError(code);
            // The native owner can complete the controller CAS before its
            // linked FIN update fails. Re-read Home authority; never apply
            // the diagnostic's machine snapshot or replay the Move.
            if (actionId === 'machines.managed.controller.update' && code === 'managed_binding_move_incomplete') {
                publishHomeAccountChange(props.serverId);
            }
            if (code === 'permission_denied' || code === 'not_authenticated' || code === 'action_account_scope_changed') props.onDenied(code);
            release();
        };
        const complete = (result: unknown) => {
            if (!binding.isCurrent() || interest.signal.aborted) return;
            if (result && typeof result === 'object' && 'kind' in result
                && (result.kind === 'conflict' || result.kind === 'refused')) {
                fail(result.kind === 'conflict' ? 'intent_changed'
                    : 'code' in result && typeof result.code === 'string' ? result.code : 'managed_request_failed');
                return;
            }
            onSucceeded?.(result);
            if (actionId !== 'machines.managed.references.get') {
                publishHomeAccountChange(props.serverId);
                refreshOperation();
                refreshPolicyParent();
            }
            release();
        };
        try {
            const result = await props.executeAction(actionId, input, { surface: 'ui', serverId: props.serverId,
                expectedAccountId: binding.accountId, signal: interest.signal });
            if (!binding.isCurrent() || interest.signal.aborted) return;
            const outcome = classifyHomeActionOutcome(result);
            if (outcome.kind === 'failed') {
                fail(homeDomainFailureCode(outcome.failure));
                return;
            }
            if (outcome.kind === 'approval_pending') {
                awaitingApproval = true;
                approval.requestApproval(createActionApprovalContinuation<unknown, ManagedMachineActionIdV1>({
                    artifactId: outcome.artifactId, actionId, scope: binding.scope, expectedInput: input,
                    signal: interest.signal, onSucceeded: complete, onFailed: fail,
                }));
                return;
            }
            complete(outcome.result);
            if (actionId !== 'machines.managed.references.get') props.onChanged();
        } catch {
            fail('managed_request_failed');
        } finally {
            if (!awaitingApproval) release();
        }
    };
    const target = { homeId: machine.homeId, managedId: machine.id };
    const canRemove = canMutate && machine.archivedAt === undefined && machine.creationState !== 'retired';
    const reviewRemoval = () => { if (canRemove) setRemoveReviewKey(deleteReviewKey); };
    // The saved admission can offer Move while the old controller is offline;
    // the destination catalog/check still decides actual reachability.
    const billing = policyParent?.billing ?? machine.reviewedFacts?.billing;
    const canMove = canMutate && billing?.location === 'cloud' && Boolean(machine.launch.credentials?.length);
    const reviewMove = async () => {
        const binding = props.binding;
        const interest = interestRef.current;
        if (!canMove || !binding?.isCurrent() || !interest || interest.signal.aborted || moveLoadingRef.current) return;
        moveLoadingRef.current = true;
        setMoveLoading(true);
        setMoveReview(null);
        setError(null);
        try {
            const candidates = await readManagedMachineMoveCandidates({ machine, binding, signal: interest.signal,
                machines: controllerMachinesRef.current ?? [], onApprovalPending: registration => approvalRequestRef.current(registration) });
            if (!binding.isCurrent() || interest.signal.aborted) return;
            setMoveReview({ key: deleteReviewKey, candidates });
        } catch {
            if (binding.isCurrent() && !interest.signal.aborted) setError('managed_request_failed');
        } finally {
            if (binding.isCurrent() && !interest.signal.aborted) { moveLoadingRef.current = false; setMoveLoading(false); }
        }
    };
    const moveController = (id: string) => {
        if (!canMutate || moveReview?.key !== deleteReviewKey) return;
        const candidate = moveReview.candidates.find(row => row.id === id);
        const controller = currentManagedMoveController(controllerMachinesRef.current?.find(row => row.id === id), machine.custodianAccountId);
        if (!candidate?.reachable || !controller || !sameStrictJsonValue(controller, candidate.controller)
            || sameStrictJsonValue(controller, machine.controller)) return;
        fireAndForget(run('machines.managed.controller.update', { ...target, expectedIntentRevision: machine.intentRevision,
            controller, reviewedPendingEffects: true }), { tag: 'ManagedMachineSections.move' });
    };
    const inspect = () => fireAndForget(run('machines.managed.inspect', target), { tag: 'ManagedMachineSections.inspect' });
    const reviewDependencies = () => {
        if (!canMutate) return;
        setDeleteReview(null);
        fireAndForget(run('machines.managed.references.get', target, result => {
            const census = ManagedMachineActionOutputSchemasV1['machines.managed.references.get'].parse(result);
            if (census.homeId !== machine.homeId || census.machineId !== null && census.machineId !== machine.enrolledMachineId) {
                setError('managed_response_invalid'); return;
            }
            setDeleteReview({ key: deleteReviewKey, census });
        }), { tag: 'ManagedMachineSections.dependencies' });
    };
    const changePolicy = (next: MachineRetentionPolicyV1) => {
        if (!canMutate || sameStrictJsonValue(next, { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage })) return;
        fireAndForget(run('machines.managed.retention.update', { ...target, expectedIntentRevision: machine.intentRevision,
            retention: next.retention, wakeOnAcceptedMessage: next.wakeOnAcceptedMessage }), { tag: 'ManagedMachineSections.policy' });
    };
    const resetPolicy = async () => {
        const binding = props.binding;
        const interest = interestRef.current;
        if (!canMutate || !binding?.isCurrent() || !interest || interest.signal.aborted || pendingRef.current) return;
        pendingRef.current = true;
        setPending('machines.managed.retention.update');
        setError(null);
        let dispatched = false;
        try {
            const result = await readManagedMachinePolicyParent({ machine, binding, signal: interest.signal,
                onApprovalPending: registration => approvalRequestRef.current(registration) });
            if (!binding.isCurrent() || interest.signal.aborted) return;
            if (result.kind === 'failed') { setError(result.code); return; }
            setPolicyParent(result.parent);
            // Reset is a concrete, newly reviewed live-policy Action, never a receipt rewrite.
            pendingRef.current = false;
            setPending(null);
            dispatched = true;
            await run('machines.managed.retention.update', { ...target, expectedIntentRevision: machine.intentRevision,
                retention: result.parent.policy.retention, wakeOnAcceptedMessage: result.parent.policy.wakeOnAcceptedMessage });
        } catch {
            if (binding.isCurrent() && !interest.signal.aborted) setError('managed_parent_unavailable');
        } finally {
            if (!dispatched && binding.isCurrent() && !interest.signal.aborted) {
                pendingRef.current = false;
                setPending(null);
            }
        }
    };
    const observedPower = machine.observation?.power;
    const resourceGone = machine.observation?.availability === 'absent' || machine.observation?.storage === 'lost';
    // Stop and Delete sit at the receipt's foot, where its cost and recipe state the consequence.
    const receiptActions: NonNullable<ManagedReceiptModel['secondary']> = bound && machine.creationState === 'active' ? [
        // An observed power state leaves only the operations that change it (lab: "Stop server" while it runs).
        ...powerIntents.filter(intent => !(intent === 'stop' ? observedPower === 'stopped' : intent === 'suspend'
            ? observedPower === 'suspended' : observedPower === 'running')).map(intent => {
            return { label: t(`managedMachines.actions.${intent}`), testID: `managed-machine.${intent}`, tone: 'bordered' as const,
                ...(intent === 'stop' ? { icon: <Icon name="stop" size={14} color={theme.colors.text.primary} /> } : {}),
                disabled: !canMutate || resourceGone, loading: pending === 'machines.managed.power.set',
                onPress: () => fireAndForget(run('machines.managed.power.set', { ...target, when: 'now', expectedRevision: machine.intentRevision,
                    intent }), { tag: 'ManagedMachineSections.power' }) };
        }),
        ...(supportedIntents.includes('delete') ? [{ label: t('managedMachines.actions.delete'), testID: 'managed-machine.delete',
            tone: 'text' as const, disabled: !canMutate,
            loading: pending === 'machines.managed.references.get' || pending === 'machines.managed.delete', onPress: reviewDependencies }] : []),
    ] : [];
    const receipt: ManagedReceiptModel = { ...buildManagedConfigurationReceipt({ launch: machine.launch,
        environment: machine.environmentSetup?.environment, reviewedFacts: machine.reviewedFacts, providerTitle: t('common.unknown'), mark,
        homeName: resolveHomeDisplayLabel(getServerProfileById(props.serverId), props.serverId), preset: machine.preset, created: true,
        controllerName: getMachineDisplayName(controllerMachines?.find(candidate =>
            candidate.id === (machine.reviewedFacts?.controller ?? machine.controller).machineId
            && candidate.installationId === (machine.reviewedFacts?.controller ?? machine.controller).installationId)) ?? t('common.unknown'),
        credentialPresentations: credentialPresentation.presentationsByKey }),
        ...(receiptActions.length ? { secondary: receiptActions } : {}) };
    const credentialRowKeys = new Set(managedCredentialReceiptTargets(machine.launch).map(target => target.key));
    const credentialNames = receipt.facts.filter(fact => credentialRowKeys.has(fact.id)).map(fact => fact.value).join(', ');
    const recipeRows = managedRecipeRows(machine, theme.colors.text.secondary);
    const nativeExpiry = policyParent?.capabilities.nativeExpiry;
    const nativeExpiryDescription = nativeExpiry && policyParent ? t('managedRetention.nativeExpiry', {
        provider: policyParent.providerTitle, time: nativeExpiry.kind === 'deadline' ? formatAsOfTime(nativeExpiry.at)
            : formatRetentionDuration(nativeExpiry.afterMs),
    }) : undefined;
    const keep: ManagedKeepProps = { policy, inherited: false, defaultPolicy: policyParent?.policy,
        finiteOnly: policyParent?.capabilities.finiteOnly,
        nativeExpiry: nativeExpiryDescription,
        effects: supportedIntents.filter((intent): intent is 'stop' | 'delete' => intent === 'stop' || intent === 'delete'),
        canWake: supportedIntents.includes('start') || supportedIntents.includes('resume'),
        consequence: describeRetention, disabled: !canMutate, onChange: changePolicy,
        onReset: () => fireAndForget(resetPolicy(), { tag: 'ManagedMachineSections.resetPolicy' }) };
    const keepChannel = useLiveValueChannel(keep);
    const setup = managedCreationSetup(machine);
    const setupRecovery = canMutate && setup && machine.enrolledMachineId ? {
        ...(setup.recoveryActions.includes('retrySetup') && machine.preset ? { retry: () => fireAndForget(run('machines.environment.apply', {
            homeId: machine.homeId, machineId: machine.enrolledMachineId!, presetId: machine.preset!.id, presetRevision: machine.preset!.revision,
        }), { tag: 'ManagedMachineSections.retrySetup' }) } : {}),
        ...(setup.recoveryActions.includes('continueWithoutSetup') ? { skip: () => fireAndForget(run('machines.managed.setup.skip',
            { ...target, expectedIntentRevision: machine.intentRevision }), { tag: 'ManagedMachineSections.skipSetup' }) } : {}),
    } : undefined;
    // Changed here means it differs from the default it would reset to; otherwise say what the rule governs.
    const policyDescription = policyParent && !sameStrictJsonValue(policyParent.policy,
        { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage })
        ? t('managedRetention.changedFor', { name: machine.launch.name }) : t('managedRetention.policyDescription');
    return <ManagedReceiptColumns receipt={receipt} compact={compact} testID="managed-machine.detail">
        {approval.approvalId ? <AttentionBanner testID="managed-machine.approval" tone="neutral"
            title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(
                `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        <ManagedCreationProgress machine={machine} operation={operation} setupRecovery={setupRecovery} handlers={{ checkNow: inspect,
            ...(canRemove ? { remove: reviewRemoval } : {}),
            ...(canMutate && currentControllerAvailable && canRetryManagedInstallation(machine, operation) ? {
                reinstall: () => fireAndForget(run('machines.managed.bootstrap.retry', { ...target,
                    expectedIntentRevision: machine.intentRevision }), { tag: 'ManagedMachineSections.retryInstall' }),
            } : {}) }} />
        <ManagedCreationScopeRuleSection machine={machine} serverId={props.serverId} />
        <ManagedMachinePolicySection testID="managed-machine.policy" description={policyDescription} keep={keep}
            compactSummary={compact ? { summary: describeRetention(policy.retention),
                onPress: () => showManagedKeepSheet(keepChannel, 'managed-machine.policy-sheet') } : undefined} />
        {requiredController ? <ManagedMachineControllerSection testID="managed-machine.controller"
            description={t('managedMachines.controller.required', { controller: controllerName })}
            controller={{ name: controllerName, icon: mark, online: controllerPresence!.online,
                presence: controllerPresence!.label, move: billing?.location === 'local' ? { kind: 'fixed' }
                    : canMove ? { kind: 'movable', onPress: () => fireAndForget(reviewMove(), { tag: 'ManagedMachineSections.moveReview' }) }
                        : { kind: 'unavailable' } }} />
            : <ItemGroup title={t('managedMachines.config.managedFrom')}><Item title={controllerName}
                subtitle={t('managedMachines.controller.required', { controller: controllerName })} mode="info" showChevron={false} testID="managed-machine.controller-unavailable" /></ItemGroup>}
        {moveReview?.key === deleteReviewKey && canMutate ? <ManagedControllerMoveList testID="managed-machine.move-candidates"
            candidates={moveReview.candidates.map(candidate => {
                const row = controllerMachines?.find(value => value.id === candidate.id);
                const presence = row ? describeMachinePresenceLine(row) : null;
                const current = row?.id === machine.controller.machineId && row.installationId === machine.controller.installationId;
                const currentInstallation = currentManagedMoveController(row, machine.custodianAccountId);
                const reachable = candidate.reachable && sameStrictJsonValue(currentInstallation, candidate.controller) && currentInstallation !== null;
                return { id: candidate.id, name: getMachineDisplayName(row) ?? candidate.id, icon: mark,
                    subtitle: presence?.online && machine.launch.credentials?.length ? t(reachable ? 'managedController.reachableAccount'
                        : 'managedController.unavailableAccount', { account: credentialNames })
                        : presence?.label ?? t('common.unknown'), online: presence?.online ?? false, current, reachable };
            })} onMove={moveController} /> : null}
        {/* A phone reads the receipt right after; the same recipe rows above it would repeat it. */}
        {compact ? null : <ManagedMachineRecipeSection testID="managed-machine.recipe" rows={recipeRows} />}
        {machine.observation ? <SurfaceFreshnessLine testID="managed-machine.observation" asOf={machine.observation.observedAt}
            action={{ label: t('managedMachines.inspect.checkNow'), onPress: inspect }} /> : null}
        {reviewedDependencies ? <ItemGroup title={t('managedMachines.dependencies.title')}
            description={t('managedMachines.dependencies.help')}>
            {reviewedDependencies.references.map(reference => <Item key={`${reference.kind}:${reference.id}`}
                title={reference.name || reference.id} subtitle={reference.id} mode="info" showChevron={false}
                testID={`managed-machine.delete-reference.${reference.kind}:${reference.id}`} />)}
            {reviewedDependencies.coverage === 'partial' ? <SurfaceStateCard kind="warning" size="line"
                title={t('managedMachines.dependencies.partial')} diagnosticCode={reviewedDependencies.unavailable.join(', ') || undefined}
                testID="managed-machine.delete-coverage" /> : reviewedDependencies.references.length === 0 ?
                <Item title={t('managedMachines.dependencies.empty')} mode="info" showChevron={false} /> : null}
            <Item title={t('managedMachines.actions.deleteMachine')} mode="info" showChevron={false} rightElement={
                <RoundButton title={t('managedMachines.actions.deleteMachine')} display="destructive" size="small"
                    testID="managed-machine.delete-confirm" disabled={!canMutate} loading={pending === 'machines.managed.delete'}
                    onPress={() => { if (canMutate && reviewedDependencies) fireAndForget(run('machines.managed.delete', {
                        ...target, when: 'now', expectedRevision: machine.intentRevision, intent: 'delete', reviewedDependencies: true,
                    }), { tag: 'ManagedMachineSections.delete' }); }} />
            } />
            <Item title={t('common.cancel')} mode="info" showChevron={false} rightElement={
                <RoundButton title={t('common.cancel')} display="secondary" size="small" disabled={!canMutate}
                    onPress={() => setDeleteReview(null)} />
            } />
        </ItemGroup> : null}
        {canRemove && !describeManagedCreation(machine).actions.includes('remove') ? <ItemGroup>
            <Item title={t('managedMachines.actions.remove')} mode="info" showChevron={false} rightElement={
                <RoundButton title={t('managedMachines.actions.remove')} display="secondary" size="small"
                    testID="managed-machine.remove" onPress={reviewRemoval} />
            } />
        </ItemGroup> : null}
        {removeReviewKey === deleteReviewKey ? <ItemGroup description={machine.allocation === 'confirmed-absent'
            || machine.observation?.availability === 'absent' ? t('managedPower.resourceAbsent') : t('managedCleanup.archiveReview')}>
            <Item title={t('managedMachines.actions.remove')} mode="info" showChevron={false} rightElement={
                <RoundButton title={t('managedMachines.actions.remove')} display="destructive" size="small"
                    testID="managed-machine.remove-confirm" disabled={!canRemove} loading={pending === 'machines.managed.retire'}
                    onPress={() => { if (canRemove) fireAndForget(run('machines.managed.retire', { ...target,
                        expectedIntentRevision: machine.intentRevision, manualResponsibility: true }), { tag: 'ManagedMachineSections.remove' }); }} />
            } />
            <Item title={t('common.cancel')} mode="info" showChevron={false} rightElement={
                <RoundButton title={t('common.cancel')} display="secondary" size="small" disabled={!canMutate}
                    onPress={() => setRemoveReviewKey(null)} />
            } />
        </ItemGroup> : null}
        {!machine.enrolledMachineId && machine.creationState === 'active' && machine.allocation !== 'confirmed-absent'
            ? <ItemGroup description={t('managedMachines.detail.cancelDescription')}>
                <Item title={t('common.cancel')} mode="info" showChevron={false} rightElement={
                    <RoundButton title={t('common.cancel')} display="destructive" size="small"
                        loading={pending === 'machines.managed.cancel'} disabled={!canMutate} testID="managed-machine.cancel"
                        onPress={() => fireAndForget(run('machines.managed.cancel', { ...target, expectedIntentRevision: machine.intentRevision }),
                            { tag: 'ManagedMachineSections.cancel' })} />
                } />
            </ItemGroup> : null}
        {error ? <SurfaceStateCard kind="error" size="line" title={error === 'intent_changed'
            ? t('managedRetention.conflict') : error === 'managed_binding_move_incomplete'
                ? t('managedController.moveIncomplete') : t('managedMachines.detail.loadFailed')} diagnosticCode={error}
            testID="managed-machine.control-error" /> : null}
    </ManagedReceiptColumns>;
}

/** The enrolled association is derived from the same admitted managed inventory, never a Machine-side copy. */
export function ManagedEnrolledMachineSections(props: Readonly<{ enrolledMachineId: string; serverId: string; executeAction?: Execute }>) {
    const serverId = resolveServerProfileScopeIdForIdentifier(props.serverId) || props.serverId;
    const serverIds = React.useMemo(() => serverId && props.enrolledMachineId ? [serverId] : [], [serverId, props.enrolledMachineId]);
    const executeAction = props.executeAction ?? execute;
    const inventory = useManagedMachineInventory(serverIds, undefined, executeAction);
    const entry = inventory.entries[serverId];
    const entryRef = React.useRef(entry);
    entryRef.current = entry;
    const [denial, setDenial] = React.useState<ManagedMachineInventoryEntry | null>(null);
    const machine = inventory.machinesByEnrolledMachineIdByServerId[serverId]?.[props.enrolledMachineId];
    const readApproval = <ManagedMachineReadApprovalNotice serverId={serverId} entry={entry} />;
    if (!machine || entry?.status === 'denied' || (denial && (entry?.status !== 'ready' || denial === entry))) return readApproval;
    return <>
        {readApproval}
        {entry?.status !== 'ready' ? <SurfaceFreshnessLine asOf={entry?.asOf} reason={t('managedMachines.detail.loadFailed')}
            action={{ label: t('common.retry'), onPress: inventory.refresh }} testID="managed-machine.freshness" /> : null}
        <ManagedMachineSections key={JSON.stringify([serverId, machine.id])} machine={machine} serverId={serverId}
            binding={inventory.bindings.get(serverId)} current={entry?.status === 'ready'} executeAction={executeAction}
            onChanged={inventory.refresh} onDenied={() => setDenial(entryRef.current ?? null)} />
    </>;
}

type ManagedKeepProps = Omit<ManagedMachineKeepControlProps, 'presentation' | 'testID' | 'showLabel'>;

function showManagedKeepSheet(channel: LiveValueChannel<ManagedKeepProps>, testID: string) {
    Modal.show({ component: ManagedKeepSheet, props: { channel, testID } });
}

/** The phone's When unused choices: the same Keep it control, following the live policy while open. */
function ManagedKeepSheet(props: Readonly<{ channel: LiveValueChannel<ManagedKeepProps>; testID: string }> & CustomModalInjectedProps) {
    const keep = useLiveValue(props.channel);
    const { setChrome } = props;
    React.useEffect(() => {
        setChrome?.({ kind: 'card', header: 'none', title: t('managedRetention.keepIt'), phonePresentation: 'sheet' });
    }, [setChrome]);
    return <ItemGroup title={t('managedRetention.whenUnused')} description={t('managedRetention.policyDescription')}>
        <SectionContentRow>
            <ManagedMachineKeepControl {...keep} presentation="choices" testID={`${props.testID}.keep`} />
        </SectionContentRow>
    </ItemGroup>;
}

/** What it was made with, from the reviewed native facts: each value first, its details beneath. */
function managedRecipeRows(machine: ManagedMachineV1, iconColor: string) {
    const native = machine.reviewedFacts?.nativeFacts;
    const title = (value: string | Readonly<{ fallback: string }>) => typeof value === 'string' ? value : value.fallback;
    const rows: { id: string; title: string; subtitle: string; leading: React.ReactNode }[] = [];
    if (native?.size) {
        const dimensions = managedSizeDimensions(native.size);
        rows.push({ id: 'size', title: title(native.size.title),
            subtitle: dimensions.length ? dimensions.join(' · ') : t('managedMachines.config.size'),
            leading: <Icon name="cpu" size={20} color={iconColor} /> });
    }
    if (native?.image) rows.push({ id: 'image', title: title(native.image.title), subtitle: t('managedMachines.config.image'),
        leading: <Icon name="image" size={20} color={iconColor} /> });
    if (native?.location) rows.push({ id: 'location', title: title(native.location.title), subtitle: t('managedMachines.config.location'),
        leading: <Icon name="map-pin" size={20} color={iconColor} /> });
    if (native?.duration) rows.push({ id: 'duration', title: title(native.duration.title), subtitle: t('managedRetention.ends'),
        leading: <Icon name="hourglass" size={20} color={iconColor} /> });
    return rows.length ? rows : [{ id: 'launch', title: machine.launch.name, subtitle: t('common.unknown'),
        leading: <Icon name="desktop" size={20} color={iconColor} /> }];
}
