import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineActionOutputSchemasV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readInputPath } from '@happier-dev/protocol/inputs';

import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { awaitActionApprovalResult, createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { countryFlag, countryName } from './managedMachineDisplay';
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
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { getPreferredLanguage, t } from '@/text';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { ManagedReceiptColumns } from './ManagedReceiptPageLayout';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { ManagedCreationScopeRuleSection } from './ManagedCreationScopeRuleSection';
import { ManagedMachineKeepControl, type ManagedMachineKeepControlProps } from './ManagedMachineKeepControl';
import { useLiveValue, useLiveValueChannel, type LiveValueChannel } from './liveValueChannel';
import { ManagedCreationProgress } from './ManagedCreationProgress';
import { ManagedMachineControllerSection, ManagedMachinePolicySection, ManagedMachineRecipeSection, ManagedControllerMoveList } from './ManagedMachineDetailSections';
import { buildManagedConfigurationReceipt, managedCredentialReceiptTargets, managedSizeDimensions } from './managedConfigurationPresentation';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import { describeRetention, describeRetentionConsequence, formatRetentionDuration } from './managedRetentionPresentation';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { canRetryManagedInstallation, describeManagedCreation, managedCreationSetup, type ManagedCreationContext } from './managedCreationPresentation';
import { useManagedMachineActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { publishActionOperationObservation, reconcileActionOperationsOnce } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { readManagedMachinePolicyParent, type ManagedMachinePolicyParent } from './managedMachinePolicyParent';
import { useManagedMachineInventory, type ManagedMachineInventoryEntry } from './useManagedMachineInventory';
import { ManagedMachineReadApprovalNotice } from './ManagedMachineReadApprovalNotice';
import { currentManagedMoveController, readManagedMachineMoveCandidates, type ManagedMachineMoveCandidate } from './managedMachineMoveCandidates';
import { happierPageTextMetrics, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { buildReviewedManagedMachineDeleteInput, qualifyManagedMachineDeleteReview, type ManagedMachineDeleteReview } from './managedMachineDeleteReview';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

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
    const provisionerPresentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: machine.controller,
        provider: machine.launch.provider, schemaVersion: machine.launch.schemaVersion });
    const mark = provisionerPresentation.mark;
    // The controller is a machine of yours: it keeps the device glyph, never the provider's mark.
    const machineMark = <Icon name="desktop" />;
    const [pending, setPending] = React.useState<ManagedMachineActionIdV1 | null>(null);
    const pendingRef = React.useRef(false);
    const [error, setError] = React.useState<string | null>(null);
    const [proposedPolicy, setProposedPolicy] = React.useState<MachineRetentionPolicyV1 | null>(null);
    // The exact submitted review remains cancelable while its durable native Ask is pending.
    const submittedPolicyRef = React.useRef<MachineRetentionPolicyV1 | null>(null);
    const keepSheetRef = React.useRef<string | null>(null);
    const closeKeepSheet = React.useCallback(() => {
        const id = keepSheetRef.current;
        keepSheetRef.current = null;
        if (id) Modal.hide(id);
    }, []);
    const [deleteReview, setDeleteReview] = React.useState<Readonly<{ key: string; review: ManagedMachineDeleteReview }> | null>(null);
    const [moveReview, setMoveReview] = React.useState<Readonly<{ key: string; candidates: readonly ManagedMachineMoveCandidate[] }> | null>(null);
    const [moveLoading, setMoveLoading] = React.useState(false);
    const moveLoadingRef = React.useRef(false);
    const [removeReviewKey, setRemoveReviewKey] = React.useState<string | null>(null);
    const deleteReviewKey = JSON.stringify([props.serverId, props.binding?.accountId, props.binding?.revision,
        machine.id, machine.intentRevision, machine.controller, machine.resource]);
    const currentDeleteReview = deleteReview?.key === deleteReviewKey ? deleteReview.review : null;
    const reviewedDependencies = currentDeleteReview?.census;
    const interestRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        const interest = new AbortController();
        interestRef.current = interest;
        pendingRef.current = false;
        setPending(null);
        setError(null);
        setProposedPolicy(null);
        submittedPolicyRef.current = null;
        setDeleteReview(null);
        setMoveReview(null);
        setRemoveReviewKey(null);
        moveLoadingRef.current = false;
        setMoveLoading(false);
        const retirement = props.binding?.onRetire(() => {
            interest.abort();
            submittedPolicyRef.current = null;
            setProposedPolicy(null);
            closeKeepSheet();
        });
        return () => {
            interest.abort();
            submittedPolicyRef.current = null;
            closeKeepSheet();
            retirement?.dispose();
            if (interestRef.current === interest) interestRef.current = null;
        };
    }, [props.binding, machine.id, closeKeepSheet]);
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
    const policy = proposedPolicy ?? machine;
    const supportedIntents = policyParent?.capabilities.supportedIntents ?? machine.reviewedFacts?.retentionCapabilities.supportedIntents ?? [];
    const canManage = props.binding?.accountId === machine.custodianAccountId
        || (requiredController?.access?.role === 'manage' && requiredController.access.accessState === 'ready');
    const canMutate = props.current && props.binding?.isCurrent() === true && machine.archivedAt === undefined
        && canManage && pending === null && !moveLoading && !approval.approvalPending;
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

    const run = async (actionId: ManagedMachineActionIdV1, input: unknown, onSucceeded?: (result: unknown) => void,
        onFailed?: () => void): Promise<boolean> => {
        const binding = props.binding;
        const interest = interestRef.current;
        if (!binding?.isCurrent() || !props.current || pendingRef.current || !interest || interest.signal.aborted
            || (actionId !== 'machines.managed.inspect' && !canManage)) return false;
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
            onFailed?.();
            if (code === 'intent_changed') props.onChanged();
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
            if (!binding.isCurrent() || interest.signal.aborted) return false;
            if (result && typeof result === 'object' && 'kind' in result
                && (result.kind === 'conflict' || result.kind === 'refused')) {
                fail(result.kind === 'conflict' ? 'intent_changed'
                    : 'code' in result && typeof result.code === 'string' ? result.code : 'managed_request_failed');
                return false;
            }
            onSucceeded?.(result);
            if (actionId !== 'machines.managed.references.get') {
                publishHomeAccountChange(props.serverId);
                refreshOperation();
                refreshPolicyParent();
            }
            release();
            return true;
        };
        try {
            const result = await props.executeAction(actionId, input, { surface: 'ui', serverId: props.serverId,
                expectedAccountId: binding.accountId, signal: interest.signal });
            if (!binding.isCurrent() || interest.signal.aborted) return false;
            const outcome = classifyHomeActionOutcome(result);
            if (outcome.kind === 'failed') {
                fail(homeDomainFailureCode(outcome.failure));
                return false;
            }
            if (outcome.kind === 'approval_pending') {
                awaitingApproval = true;
                if (actionId === 'machines.managed.retention.update') {
                    // Keep's existing result seam waits for this exact native Artifact, not Ask admission.
                    const saved = await awaitActionApprovalResult<boolean, Readonly<{ saved: boolean }>>({
                        signal: interest.signal,
                        execute: async callbacks => {
                            approval.requestApproval(createActionApprovalContinuation<unknown, ManagedMachineActionIdV1>({
                                artifactId: outcome.artifactId, actionId, scope: binding.scope, expectedInput: input,
                                signal: interest.signal,
                                onSucceeded: value => { callbacks.onApprovalSucceeded(complete(value)); },
                                onFailed: (code, failure) => { fail(code); callbacks.onApprovalFailed(code, failure); },
                            }));
                            return { approvalPending: true };
                        },
                        succeeded: saved => ({ saved }), failed: () => ({ saved: false }), aborted: () => ({ saved: false }),
                    });
                    return saved.saved;
                }
                approval.requestApproval(createActionApprovalContinuation<unknown, ManagedMachineActionIdV1>({
                    artifactId: outcome.artifactId, actionId, scope: binding.scope, expectedInput: input,
                    signal: interest.signal, onSucceeded: value => { complete(value); }, onFailed: fail,
                }));
                return false;
            }
            const succeeded = complete(outcome.result);
            if (succeeded && actionId !== 'machines.managed.references.get') props.onChanged();
            return succeeded;
        } catch {
            fail('managed_request_failed');
            return false;
        } finally {
            if (!awaitingApproval) release();
        }
    };
    const target = { homeId: machine.homeId, managedId: machine.id };
    const recoveryConsoleUrl = machine.recovery?.consoleUrl;
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
            const review = qualifyManagedMachineDeleteReview(machine, result);
            if (!review) { setError('managed_response_invalid'); return; }
            setDeleteReview({ key: deleteReviewKey, review });
        }), { tag: 'ManagedMachineSections.dependencies' });
    };
    const changePolicy = async (next: MachineRetentionPolicyV1) => {
        if (!canMutate || !policyParent) return false;
        if (sameStrictJsonValue(next, { retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage })) {
            submittedPolicyRef.current = null;
            setProposedPolicy(null);
            return true;
        }
        submittedPolicyRef.current = next;
        return run('machines.managed.retention.update', { ...target, expectedIntentRevision: machine.intentRevision,
            retention: next.retention, wakeOnAcceptedMessage: next.wakeOnAcceptedMessage },
            () => {
                if (submittedPolicyRef.current !== next) return;
                submittedPolicyRef.current = null;
                setProposedPolicy(current => current === next || current === proposedPolicy ? null : current);
            }, () => { if (submittedPolicyRef.current === next) setProposedPolicy(next); });
    };
    const resetPolicy = async (): Promise<boolean> => {
        const binding = props.binding;
        const interest = interestRef.current;
        if (!canMutate || !binding?.isCurrent() || !interest || interest.signal.aborted || pendingRef.current) return false;
        const submittedPolicy = submittedPolicyRef.current;
        pendingRef.current = true;
        setPending('machines.managed.retention.update');
        setError(null);
        let dispatched = false;
        try {
            const result = await readManagedMachinePolicyParent({ machine, binding, signal: interest.signal,
                onApprovalPending: registration => approvalRequestRef.current(registration) });
            if (!binding.isCurrent() || interest.signal.aborted) return false;
            if (result.kind === 'failed') { setError(result.code); return false; }
            setPolicyParent(result.parent);
            // Reset is a concrete, newly reviewed live-policy Action, never a receipt rewrite.
            pendingRef.current = false;
            setPending(null);
            dispatched = true;
            return await run('machines.managed.retention.update', { ...target, expectedIntentRevision: machine.intentRevision,
                retention: result.parent.policy.retention, wakeOnAcceptedMessage: result.parent.policy.wakeOnAcceptedMessage },
                () => {
                    if (submittedPolicyRef.current === submittedPolicy) submittedPolicyRef.current = null;
                    setProposedPolicy(current => current === proposedPolicy ? null : current);
                });
        } catch {
            if (binding.isCurrent() && !interest.signal.aborted) setError('managed_parent_unavailable');
            return false;
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
    const receiptActions: NonNullable<ManagedReceiptModel['secondary']> = bound && machine.creationState === 'active' && machine.archivedAt === undefined ? [
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
        environment: machine.environmentSetup?.environment, reviewedFacts: machine.reviewedFacts,
        providerTitle: provisionerPresentation.title ?? policyParent?.providerTitle ?? t('common.machine'), mark,
        localized: provisionerPresentation.localized,
        homeName: resolveHomeDisplayLabel(getServerProfileById(props.serverId), props.serverId), preset: machine.preset, created: true,
        nativeLifetimePresented: policyParent?.capabilities.finiteOnly === true,
        controllerName: getMachineDisplayName(controllerMachines?.find(candidate =>
            candidate.id === (machine.reviewedFacts?.controller ?? machine.controller).machineId
            && candidate.installationId === (machine.reviewedFacts?.controller ?? machine.controller).installationId)) ?? t('common.unknown'),
        credentialPresentations: credentialPresentation.presentationsByKey }),
        ...(receiptActions.length ? { secondary: receiptActions } : {}) };
    const credentialRowKeys = new Set(managedCredentialReceiptTargets(machine.launch).map(target => target.key));
    const credentialNames = receipt.facts.filter(fact => credentialRowKeys.has(fact.id)).map(fact => fact.value).join(', ');
    const recipeRows = managedRecipeRows(machine, provisionerPresentation.localized);
    const nativeExpiry = machine.observation?.nativeExpiry;
    const nativeExpiryDescription = nativeExpiry !== undefined ? t('managedRetention.nativeExpiry', {
        provider: provisionerPresentation.title ?? policyParent?.providerTitle ?? t('common.machine'), time: formatAsOfTime(nativeExpiry),
    }) : undefined;
    const providerName = provisionerPresentation.title ?? policyParent?.providerTitle;
    // The consequence says what the rule means for the bill, from the provider's own billing facts.
    const consequence = (retention: MachineRetentionPolicyV1['retention']) => billing && providerName
        ? describeRetentionConsequence(retention, { location: billing.location, stoppedBilling: billing.stoppedBilling, provider: providerName })
        : describeRetention(retention);
    const creationContext: ManagedCreationContext = { provider: providerName,
        providerAvailable: requiredController && provisionerPresentation.projectionReady ? provisionerPresentation.title !== null : undefined,
        ...(controller && controllerPresence ? { controller: { name: controllerName, online: controllerPresence.online } } : {}) };
    const keep: ManagedKeepProps = { policy, inherited: false, defaultPolicy: policyParent?.policy,
        finiteOnly: policyParent?.capabilities.finiteOnly,
        capabilitiesAvailable: policyParent !== null,
        nativeExpiry: nativeExpiryDescription,
        effects: supportedIntents.filter((intent): intent is 'stop' | 'delete' => intent === 'stop' || intent === 'delete'),
        canWake: supportedIntents.includes('start') || supportedIntents.includes('resume'),
        // A live machine is where an explicit, reviewed deadline is set (plan 52); the Action still asks first.
        deadline: true,
        consequence, disabled: !canMutate || !policyParent, onChange: changePolicy,
        onCancel: () => { submittedPolicyRef.current = null; setProposedPolicy(null); },
        onReset: resetPolicy };
    const keepChannel = useLiveValueChannel(keep);
    const setup = managedCreationSetup(machine);
    const setupRecovery = canMutate && setup && machine.enrolledMachineId ? {
        ...(setup.recoveryActions.includes('retrySetup') && machine.preset ? { retry: () => fireAndForget(run('machines.environment.apply', {
            homeId: machine.homeId, machineId: machine.enrolledMachineId!, presetId: machine.preset!.id, presetRevision: machine.preset!.revision,
        }), { tag: 'ManagedMachineSections.retrySetup' }) } : {}),
        ...(setup.recoveryActions.includes('continueWithoutSetup') ? { skip: () => fireAndForget(run('machines.managed.setup.skip',
            { ...target, expectedIntentRevision: machine.intentRevision }), { tag: 'ManagedMachineSections.skipSetup' }) } : {}),
    } : undefined;
    const canCancelCreation = !machine.enrolledMachineId && machine.creationState === 'active' && machine.allocation !== 'confirmed-absent';
    const cancelCreation = () => fireAndForget(run('machines.managed.cancel', { ...target, expectedIntentRevision: machine.intentRevision }),
        { tag: 'ManagedMachineSections.cancel' });
    const canCancelCreationRow = canCancelCreation && !describeManagedCreation(machine, creationContext).actions.includes('cancel');
    // Changed here means it differs from the default it would reset to; otherwise say what the rule governs.
    const policyDescription = policyParent && !sameStrictJsonValue(policyParent.policy,
        { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage })
        ? t('managedRetention.changedFor', { name: machine.launch.name }) : t('managedRetention.policyDescription');
    return <ManagedReceiptColumns receipt={receipt} compact={compact} testID="managed-machine.detail">
        {approval.approvalId ? <AttentionBanner testID="managed-machine.approval" tone="neutral"
            title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(
                `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        <ManagedCreationProgress machine={machine} operation={operation} setupRecovery={setupRecovery} provider={providerName}
            providerAvailable={creationContext.providerAvailable}
            mark={mark} controller={creationContext.controller} handlers={{ checkNow: inspect,
            ...(canCancelCreation && canMutate ? { cancel: cancelCreation } : {}),
            ...(recoveryConsoleUrl ? { openProvider: () => {
                if (!props.binding?.isCurrent()) return;
                fireAndForget(openExternalUrl(recoveryConsoleUrl), { tag: 'ManagedMachineSections.openConsole' });
            } } : {}),
            ...(canRemove ? { remove: reviewRemoval } : {}),
            ...(canMutate && currentControllerAvailable && machine.creationState === 'active'
                && machine.submittedNativeEffect?.intent === 'delete' ? { tryAgain: reviewDependencies } : {}),
            ...(canMutate && props.binding?.accountId === machine.custodianAccountId ? {
                reconnect: () => router.push({ pathname: SETTINGS_ROUTES.connectedServices, params: { serverId: props.serverId,
                    machineId: machine.controller.machineId } }),
                ...(creationContext.providerAvailable === false ? { reinstall: () => router.push({ pathname: SETTINGS_ROUTES.plugins,
                    params: { serverId: props.serverId, machineId: machine.controller.machineId } }) } : {}),
            } : {}),
            ...(canMutate && currentControllerAvailable && canRetryManagedInstallation(machine, operation) ? {
                reinstall: () => fireAndForget(run('machines.managed.bootstrap.retry', { ...target,
                    expectedIntentRevision: machine.intentRevision }), { tag: 'ManagedMachineSections.retryInstall' }),
            } : {}) }} />
        <ManagedCreationScopeRuleSection machine={machine} serverId={props.serverId} binding={props.binding} />
        <ManagedMachinePolicySection testID="managed-machine.policy" description={policyDescription} keep={keep}
            compactSummary={compact ? { summary: describeRetention(policy.retention),
                onPress: () => {
                    closeKeepSheet();
                    keepSheetRef.current = showManagedKeepSheet(keepChannel, 'managed-machine.policy-sheet');
                } } : undefined} />
        {requiredController ? <ManagedMachineControllerSection testID="managed-machine.controller"
            description={t('managedMachines.controller.required', { controller: controllerName })}
            controller={{ name: controllerName, icon: machineMark, online: controllerPresence!.online,
                presence: controllerPresence!.label, move: billing?.location === 'local' ? { kind: 'fixed' }
                    : canMove ? { kind: 'movable', onPress: () => fireAndForget(reviewMove(), { tag: 'ManagedMachineSections.moveReview' }) }
                        : { kind: 'unavailable' } }} />
            : <ItemGroup title={t('managedMachines.config.managedFrom')}><Item title={controllerName}
                subtitle={t('managedMachines.controller.required', { controller: controllerName })} mode="info" showChevron={false}
                testID="managed-machine.controller-unavailable" accessoryLayout="adaptive" rightElement={canMove ?
                    <RoundButton title={t('managedController.moveShort')} display="secondary" size="small"
                        testID="managed-machine.controller-unavailable:move"
                        onPress={() => fireAndForget(reviewMove(), { tag: 'ManagedMachineSections.moveReview' })} /> : undefined} /></ItemGroup>}
        {moveReview?.key === deleteReviewKey && canMutate ? <ManagedControllerMoveList testID="managed-machine.move-candidates"
            candidates={moveReview.candidates.map(candidate => {
                const row = controllerMachines?.find(value => value.id === candidate.id);
                const presence = row ? describeMachinePresenceLine(row) : null;
                const current = row?.id === machine.controller.machineId && row.installationId === machine.controller.installationId;
                const currentInstallation = currentManagedMoveController(row, machine.custodianAccountId);
                const reachable = candidate.reachable && sameStrictJsonValue(currentInstallation, candidate.controller) && currentInstallation !== null;
                return { id: candidate.id, name: getMachineDisplayName(row) ?? candidate.id, icon: machineMark,
                    subtitle: presence?.online && machine.launch.credentials?.length ? t(reachable ? 'managedController.reachableAccount'
                        : 'managedController.unavailableAccount', { account: credentialNames })
                        : presence?.label ?? t('common.unknown'), online: presence?.online ?? false, current, reachable };
            })} onMove={moveController} /> : null}
        {/* A phone reads the receipt right after; the same recipe rows above it would repeat it. */}
        {compact ? null : <ManagedMachineRecipeSection testID="managed-machine.recipe" rows={recipeRows} />}
        {machine.observation ? <ItemGroup><Item testID="managed-machine.observation" mode="info" showChevron={false}
            title={t('surfaceState.asOf', { time: formatAsOfTime(machine.observation.observedAt) })}
            rightElement={<RoundButton title={t('managedMachines.inspect.checkNow')} display="inverted" size="small"
                testID="managed-machine.observation-check" onPress={inspect} />} /></ItemGroup> : null}
        {reviewedDependencies ? <ItemGroup title={t('managedMachines.dependencies.title')}>
            {reviewedDependencies.references.map(reference => <Item key={`${reference.kind}:${reference.id}`}
                title={reference.name || reference.id} subtitle={reference.id} mode="info" showChevron={false}
                testID={`managed-machine.delete-reference.${reference.kind}:${reference.id}`} />)}
            {reviewedDependencies.coverage === 'partial' ? <SurfaceStateCard kind="warning" size="line"
                title={t('managedMachines.dependencies.partial')} diagnosticCode={reviewedDependencies.unavailable.join(', ') || undefined}
                testID="managed-machine.delete-coverage" /> : reviewedDependencies.references.length === 0 ?
                <Item title={t('managedMachines.dependencies.empty')} mode="info" showChevron={false} /> : null}
        </ItemGroup> : null}
        {/* The decision closes the page as one quiet button row: the way back, then the irreversible step last. */}
        {reviewedDependencies ? <ManagedDecisionRow testID="managed-machine.delete-decision" footnote={t('managedMachines.dependencies.help')}
            onCancel={canMutate ? () => setDeleteReview(null) : undefined}
            confirm={{ label: t('managedMachines.actions.deleteMachine'), testID: 'managed-machine.delete-confirm', disabled: !canMutate,
                loading: pending === 'machines.managed.delete', onPress: () => {
                    if (!canMutate || !currentDeleteReview) return;
                    const input = buildReviewedManagedMachineDeleteInput(machine, currentDeleteReview);
                    if (!input) { setError('intent_changed'); return; }
                    fireAndForget(run('machines.managed.delete', input), { tag: 'ManagedMachineSections.delete' });
                } }} /> : null}
        {canRemove && removeReviewKey !== deleteReviewKey && !describeManagedCreation(machine, creationContext).actions.includes('remove')
            ? <ItemGroup surface="none"><SectionButtonRow testID="managed-machine.remove-row">
                <RoundButton title={t('managedMachines.actions.remove')} display="secondary" size="small"
                    testID="managed-machine.remove" onPress={reviewRemoval} />
            </SectionButtonRow></ItemGroup> : null}
        {removeReviewKey === deleteReviewKey ? <ManagedDecisionRow testID="managed-machine.remove-decision"
            footnote={machine.allocation === 'confirmed-absent' || machine.observation?.availability === 'absent'
                ? t('managedPower.resourceAbsent') : t('managedCleanup.archiveReview')}
            onCancel={canMutate ? () => setRemoveReviewKey(null) : undefined}
            confirm={{ label: t('managedMachines.actions.remove'), testID: 'managed-machine.remove-confirm', disabled: !canRemove,
                loading: pending === 'machines.managed.retire', onPress: () => { if (canRemove) fireAndForget(run('machines.managed.retire', { ...target,
                    expectedIntentRevision: machine.intentRevision, manualResponsibility: true }), { tag: 'ManagedMachineSections.remove' }); } }} /> : null}
        {/* An offline controller's banner already carries Cancel; the closing row would say it twice. */}
        {canCancelCreationRow ? <ManagedDecisionRow testID="managed-machine.cancel-decision" footnote={t('managedMachines.detail.cancelDescription')}
            confirm={{ label: t('managedMachines.actions.cancelCreation'), testID: 'managed-machine.cancel', disabled: !canMutate,
                loading: pending === 'machines.managed.cancel', onPress: cancelCreation }} /> : null}
        {error ? <SurfaceStateCard kind="error" size="line" title={error === 'intent_changed'
            ? t('managedRetention.conflict') : error === 'managed_binding_move_incomplete'
                ? t('managedController.moveIncomplete') : t('managedMachines.detail.loadFailed')} diagnosticCode={error}
            testID="managed-machine.control-error" /> : null}
    </ManagedReceiptColumns>;
}

/**
 * The enrolled association, derived from the same admitted managed inventory, never a Machine-side
 * copy. A Machine page reads it once and gives it to both its header and its managed sections.
 */
export function useManagedEnrolledMachine(props: Readonly<{ enrolledMachineId: string | undefined; serverId: string; executeAction?: Execute }>) {
    const serverId = resolveServerProfileScopeIdForIdentifier(props.serverId) || props.serverId;
    const serverIds = React.useMemo(() => serverId && props.enrolledMachineId ? [serverId] : [], [serverId, props.enrolledMachineId]);
    const executeAction = props.executeAction ?? execute;
    const inventory = useManagedMachineInventory(serverIds, undefined, executeAction);
    const entry = inventory.entries[serverId];
    const entryRef = React.useRef(entry);
    entryRef.current = entry;
    const [denial, setDenial] = React.useState<ManagedMachineInventoryEntry | null>(null);
    const found = props.enrolledMachineId ? inventory.machinesByEnrolledMachineIdByServerId[serverId]?.[props.enrolledMachineId] : undefined;
    const machine = !found || entry?.status === 'denied' || (denial && (entry?.status !== 'ready' || denial === entry)) ? undefined : found;
    const deny = React.useCallback(() => setDenial(entryRef.current ?? null), []);
    return { serverId, inventory, entry, machine, executeAction, deny };
}
export type ManagedEnrolledMachine = ReturnType<typeof useManagedEnrolledMachine>;

export function ManagedEnrolledMachineSections(props: Readonly<{ enrolledMachineId: string; serverId: string; executeAction?: Execute }>) {
    return <ManagedEnrolledMachineSectionsView enrolled={useManagedEnrolledMachine(props)} />;
}

export function ManagedEnrolledMachineSectionsView(props: Readonly<{ enrolled: ManagedEnrolledMachine }>) {
    const { serverId, inventory, entry, machine, executeAction, deny } = props.enrolled;
    const readApproval = <ManagedMachineReadApprovalNotice serverId={serverId} entry={entry} />;
    if (!machine) return readApproval;
    return <>
        {readApproval}
        {entry?.status !== 'ready' ? <SurfaceFreshnessLine asOf={entry?.asOf} reason={t('managedMachines.detail.loadFailed')}
            action={{ label: t('common.retry'), onPress: inventory.refresh }} testID="managed-machine.freshness" /> : null}
        <ManagedMachineSections key={JSON.stringify([serverId, machine.id])} machine={machine} serverId={serverId}
            binding={inventory.bindings.get(serverId)} current={entry?.status === 'ready'} executeAction={executeAction}
            onChanged={inventory.refresh} onDenied={deny} />
    </>;
}

export type ManagedMachineHeaderIdentity = Readonly<{
    mark: React.ReactNode;
    description: string | null;
    meta: readonly PageHeaderMetaFact[];
}>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long it has been up, in its largest whole unit ("3 h", "2 d", "20 min"). */
function formatUptime(ms: number): string {
    const unit = ms >= DAY_MS ? DAY_MS : ms >= HOUR_MS ? HOUR_MS : MINUTE_MS;
    return formatRetentionDuration(Math.max(1, Math.floor(ms / unit)) * unit);
}

/**
 * A created machine's header facts (lab `m-detail`: "Running 3 h" · "Hetzner server 58213904"), from
 * real facts only: power from the provider's own observation, how long it has been running only when
 * the caller knows when it came up, and the provider's id only where its declaration names the field
 * in the resource value. Anything unknown is left out rather than guessed.
 */
export function managedMachineHeaderMeta(input: Readonly<{
    machine: Readonly<{ observation?: ManagedMachineV1['observation']; resource?: Readonly<{ value: unknown }> }>;
    provider: string | null; kindTitle: string | null;
    /** The declared path of the provider's own id in the resource value. */
    resourceIdPath?: string;
    /** When the machine's Happier came up (its connected daemon's start), for a running machine's uptime. */
    runningSince?: number;
    now: number;
}>): PageHeaderMetaFact[] {
    const meta: PageHeaderMetaFact[] = [];
    const power = input.machine.observation?.availability === 'present' ? input.machine.observation.power : undefined;
    if (power === 'running' || power === 'stopped' || power === 'suspended') {
        const uptime = power === 'running' && input.runningSince !== undefined && input.runningSince <= input.now
            ? formatUptime(input.now - input.runningSince) : null;
        meta.push({ key: 'managed-power', testID: 'machine-detail-managed-power',
            text: uptime ? t('managedMachines.detail.runningFor', { duration: uptime }) : t(`managedMachines.detail.power.${power}`) });
    }
    if (input.provider) {
        const kind = input.kindTitle ? t('managedMachines.detail.kindFact', { provider: input.provider, kind: input.kindTitle }) : input.provider;
        const value = input.resourceIdPath ? readInputPath(input.machine.resource?.value, input.resourceIdPath) : undefined;
        const nativeId = typeof value === 'number' || (typeof value === 'string' && value.length > 0) ? String(value) : null;
        meta.push({ key: 'managed-kind', text: nativeId ? t('managedMachines.detail.kindFactWithId', { fact: kind, id: nativeId }) : kind });
    }
    return meta;
}

/**
 * Who a created machine is, for its page header (lab `m-detail`): the provider's mark, where it came
 * from ("Made from the Build box preset."), and its observed power, uptime, kind and native id beside the
 * ordinary facts. Identity comes from the installed provisioner declaration, so the header asks no
 * machine anything.
 */
export function useManagedMachineHeaderIdentity(machine: ManagedMachineV1 | undefined, serverId: string,
    live?: Readonly<{ runningSince?: number }>): ManagedMachineHeaderIdentity | null {
    const presentation = useManagedProvisionerPresentation({ serverId, controller: machine?.controller,
        provider: machine?.launch.provider, schemaVersion: machine?.launch.schemaVersion });
    if (!machine) return null;
    const provider = presentation.title;
    const presetName = machine.reviewedFacts?.preset?.name;
    const meta = managedMachineHeaderMeta({ machine, provider, kindTitle: presentation.kindTitle,
        resourceIdPath: presentation.resourceIdPath ?? undefined, runningSince: live?.runningSince, now: Date.now() });
    return { mark: presentation.mark,
        description: presetName ? t('managedMachines.detail.madeFromPreset', { preset: presetName })
            : provider ? t('managedMachines.detail.createdOn', { provider }) : null,
        meta };
}

type ManagedKeepProps = Omit<ManagedMachineKeepControlProps, 'presentation' | 'testID' | 'showLabel'>;

/**
 * A reviewed decision closes the page as one quiet button row (anatomy: destructive actions): the way
 * back stays quiet, the irreversible step is destructive and last, and its consequence is said once
 * beneath. The button already names the decision, so no row repeats it.
 */
export function ManagedDecisionRow(props: Readonly<{
    testID: string;
    footnote: string;
    onCancel?: () => void;
    confirm: Readonly<{ label: string; testID: string; disabled: boolean; loading: boolean; onPress: () => void }>;
}>) {
    return <ItemGroup surface="none">
        <SectionButtonRow testID={props.testID} footnote={props.footnote} footnoteTestID={`${props.testID}.footnote`}
            trailing={<RoundButton title={props.confirm.label} display="destructive" size="small" testID={props.confirm.testID}
                disabled={props.confirm.disabled} loading={props.confirm.loading} onPress={props.confirm.onPress} />}>
            {props.onCancel ? <RoundButton title={t('common.cancel')} display="inverted" size="small" textStyle={Typography.default()}
                testID={`${props.testID}.cancel`} onPress={props.onCancel} /> : null}
        </SectionButtonRow>
    </ItemGroup>;
}

function showManagedKeepSheet(channel: LiveValueChannel<ManagedKeepProps>, testID: string) {
    return Modal.show({ component: ManagedKeepSheet, props: { channel, testID } });
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

/**
 * What it was made with, from the reviewed native facts: each value first, then the fact that tells it
 * apart (its dimensions, what the system is, the country and region id). Glyphs are bare; the row owner
 * sizes and colours them. A place leads with its country's flag, as in the configurator.
 */
function managedRecipeRows(machine: ManagedMachineV1, localized: PluginLocalizedTextResolver) {
    const native = machine.reviewedFacts?.nativeFacts;
    const title = (value: unknown) => localized(machine.launch.provider.pluginId, value);
    const rows: { id: string; title: string; subtitle: string; leading: React.ReactNode }[] = [];
    if (native?.size) {
        const dimensions = managedSizeDimensions(native.size);
        rows.push({ id: 'size', title: title(native.size.title),
            subtitle: dimensions.length ? dimensions.join(' · ') : t('managedMachines.config.size'),
            leading: <Icon name="cpu" /> });
    }
    if (native?.image) rows.push({ id: 'image', title: title(native.image.title),
        subtitle: native.image.description ? title(native.image.description) : t('managedMachines.config.image'),
        leading: <Icon name="image" /> });
    if (native?.location) {
        const flag = countryFlag(native.location.countryCode);
        const country = countryName(native.location.countryCode, getPreferredLanguage());
        rows.push({ id: 'location', title: title(native.location.title),
            subtitle: [country, native.location.id].filter(Boolean).join(' · '),
            leading: flag ? <Text style={recipeStyles.flag}>{flag}</Text> : <Icon name="map-pin" /> });
    }
    if (native?.duration) rows.push({ id: 'duration', title: title(native.duration.title), subtitle: t('managedRetention.ends'),
        leading: <Icon name="hourglass" /> });
    return rows.length ? rows : [{ id: 'launch', title: machine.launch.name, subtitle: t('common.unknown'),
        leading: <Icon name="desktop" /> }];
}

const recipeStyles = StyleSheet.create({
    flag: { ...happierPageTextMetrics('rowTitle') },
});
