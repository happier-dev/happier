import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { StoredMachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { DevcontainerEffectReviewV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { ManagedMachineActionOutputSchemasV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { isMachineRetainedWakeEligibleV1, supportedMachineRetentionEffectsV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
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
import { useServerScopedMachine, useMachineListForServer } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { readOpenManagedMachineApprovalId } from '@/sync/domains/artifacts/approvalArtifacts';
import { resolveActionTitle } from '@/text/actionTitles';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { getMachineDisplayName, isMachineDisplayHydrating, readMachineName } from '@/utils/sessions/machineDisplayNames';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
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
import { describeRetention, describeRetentionConsequence, formatRetentionDuration, retentionParking } from './managedRetentionPresentation';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { canRetryManagedInstallation, currentManagedCreationOperation, describeManagedCreation, managedCreationSetup, managedReceiptPowerIntents, readManagedInstallationPrompt, type ManagedCreationContext } from './managedCreationPresentation';
import { useManagedMachineActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { publishActionOperationObservation, reconcileActionOperationsOnce } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { readManagedMachinePolicyParent, readManagedMachineRebuildReview, type ManagedMachinePolicyParent } from './managedMachinePolicyParent';
import { useManagedMachineInventory, type ManagedMachineInventoryEntry } from './useManagedMachineInventory';
import { ManagedMachineReadApprovalNotice } from './ManagedMachineReadApprovalNotice';
import { currentManagedMoveController, readManagedMachineMoveCandidates, type ManagedMachineMoveCandidate } from './managedMachineMoveCandidates';
import { happierPageTextMetrics, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { buildReviewedManagedMachineDeleteInput, qualifyManagedMachineDeleteReview, type ManagedMachineDeleteReview } from './managedMachineDeleteReview';
import { MANAGED_PROVISIONER_MARK_SIZE, useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { projectManagedMachineApproval, shouldReleaseManagedMachinePendingOnApproval } from './managedMachineDetailPresentation';

const execute = createFrontDoorActionExecute();
type Execute = ReturnType<typeof createDefaultActionExecutor>['execute'];
type SectionProps = Readonly<{
    machine: ManagedMachineV1;
    serverId: string;
    binding?: ServerCredentialAccountScopeBinding;
    current: boolean;
    executeAction: Execute;
    onChanged: () => void;
    /** The created-machine list could not be re-read; the state row's freshness says so with Retry. */
    staleRead?: Readonly<{ retry: () => void }>;
    onDenied: (code: string) => void;
}>;

/**
 * One mounted detail consumer for pre-enrollment and ordinary enrolled Machine pages (lab `m-detail`):
 * what blocks use, the creation scope rule, the live Keep it, the controller and the recipe on the
 * left, the immutable receipt beside them with native controls at its foot. A phone reads the same
 * sections with Keep it as a summary row, then the receipt.
 */
const PENDING_READ = Object.freeze({ kind: 'loading' } as const);

/** The managing computer's name, `null` while the machine list is still reading it, or "Unknown" once read without it. */
function controllerNameOrPending(controller: Parameters<typeof getMachineDisplayName>[0], list: readonly unknown[] | null | undefined): string | null {
    if (controller ? isMachineDisplayHydrating(controller) : !list) return null;
    return getMachineDisplayName(controller) ?? t('common.unknown');
}

function controllerRequired(name: string | null): string {
    return name === null ? t('managedMachines.controller.requiredUnnamed') : t('managedMachines.controller.required', { controller: name });
}

export function ManagedMachineSections(props: SectionProps) {
    const { machine } = props;
    const { theme } = useUnistyles();
    const router = useRouter();
    const layout = useHappierCollectionLayout();
    const compact = useDeviceType() === 'phone' || layout?.mode === 'stacked';
    const controller = useServerScopedMachine(props.serverId, machine.controller.machineId);
    const enrolledMachine = useServerScopedMachine(props.serverId, machine.enrolledMachineId ?? '');
    const controllerMachines = useMachineListForServer(props.serverId);
    const presenceNowMs = useMachinePresenceNowMs(controllerMachines ?? []);
    useMachineReachabilityRevision();
    const controllerMachinesRef = React.useRef(controllerMachines);
    controllerMachinesRef.current = controllerMachines;
    // Until the machine list has read the controller's name it is pending (`null`): rows hold their place and
    // sentences that would name it say "the computer that manages it", never "Loading…" or "Unknown".
    const controllerName = controllerNameOrPending(controller, controllerMachines);
    // The page's name for this resource: its enrolled Machine's, else what Create was given.
    const machineName = readMachineName(enrolledMachine) ?? machine.launch.name;
    const credentialTargets = React.useMemo(() => managedCredentialReceiptTargets(machine.launch), [machine.launch]);
    const credentialPresentation = useQualifiedConnectedAccountTargetPresentations({
        binding: props.binding ?? null, targets: credentialTargets,
    });
    const reachabilityScope = props.binding?.isCurrent() ? props.binding.scope : null;
    const controllerPresence = controller ? describeMachinePresenceLine(controller, presenceNowMs, undefined, reachabilityScope) : null;
    const requiredController = controller?.installationId === machine.controller.installationId ? controller : null;
    const provisionerPresentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: machine.controller,
        provider: machine.launch.provider, schemaVersion: machine.launch.schemaVersion });
    // The controller is a machine of yours: it keeps the device glyph, never the provider's mark.
    const machineMark = <Icon name="desktop" />;
    const [pending, setPending] = React.useState<ManagedMachineActionIdV1 | null>(null);
    const pendingRef = React.useRef(false);
    const submittedDeleteApprovalIdRef = React.useRef<string | null>(null);
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
    const [rebuildReview, setRebuildReview] = React.useState<Readonly<{ key: string; review: DevcontainerEffectReviewV1 }> | null>(null);
    const [moveReview, setMoveReview] = React.useState<Readonly<{ key: string; candidates: readonly ManagedMachineMoveCandidate[] }> | null>(null);
    const [moveLoading, setMoveLoading] = React.useState(false);
    const moveLoadingRef = React.useRef(false);
    const [removeReviewKey, setRemoveReviewKey] = React.useState<string | null>(null);
    const deleteReviewKey = JSON.stringify([props.serverId, props.binding?.accountId, props.binding?.revision,
        machine.id, machine.intentRevision, machine.controller, machine.resource]);
    const currentDeleteReview = deleteReview?.key === deleteReviewKey ? deleteReview.review : null;
    const rebuildReviewKey = JSON.stringify([deleteReviewKey, machine.launch]);
    const currentRebuildReview = rebuildReview?.key === rebuildReviewKey ? rebuildReview.review : null;
    const reviewedDependencies = currentDeleteReview?.census;
    const interestRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        const interest = new AbortController();
        interestRef.current = interest;
        pendingRef.current = false;
        submittedDeleteApprovalIdRef.current = null;
        setPending(null);
        setError(null);
        setProposedPolicy(null);
        submittedPolicyRef.current = null;
        setDeleteReview(null);
        setRebuildReview(null);
        setMoveReview(null);
        setRemoveReviewKey(null);
        moveLoadingRef.current = false;
        setMoveLoading(false);
        const retirement = props.binding?.onRetire(() => {
            interest.abort();
            submittedPolicyRef.current = null;
            setProposedPolicy(null);
            setRebuildReview(null);
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
    // A Delete already waiting in Inbox (filed here earlier, elsewhere, or by Cancel's cleanup) is shown, never filed again.
    const selectPendingDelete = React.useMemo(() => {
        let artifacts: StorageState['artifacts'] | null = null;
        let id: string | null = null;
        return (state: StorageState) => {
            if (state.artifacts !== artifacts) {
                artifacts = state.artifacts;
                id = readOpenManagedMachineApprovalId(Object.values(state.artifacts),
                    { homeId: machine.homeId, managedId: machine.id, actionId: 'machines.managed.delete' });
            }
            return id;
        };
    }, [machine.homeId, machine.id]);
    const storedDeleteApprovalId = storage(selectPendingDelete);
    const approvalPresentation = projectManagedMachineApproval({ approvalId: approval.approvalId,
        submittedDeleteApprovalId: submittedDeleteApprovalIdRef.current, storedDeleteApprovalId });
    const pendingDeleteApprovalId = approvalPresentation?.kind === 'delete' ? approvalPresentation.artifactId : null;
    const openApproval = (artifactId: string) => router.push(
        `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(props.serverId)}` as never);
    const approvalRequestRef = React.useRef(approval.requestApproval);
    approvalRequestRef.current = approval.requestApproval;
    const [policyParent, setPolicyParent] = React.useState<ManagedMachinePolicyParent | null>(null);
    const [parentReadRevision, refreshPolicyParent] = React.useReducer(value => value + 1, 0);
    const [parentReadFailed, setParentReadFailed] = React.useState(false);
    const policyController = requiredController && controllerPresence?.online ? machine.controller
        : controllerMachines?.map(row => currentManagedMoveController(row, machine.custodianAccountId, reachabilityScope)).find(row => row !== null)
            ?? (requiredController ? machine.controller : null);
    const parentReadKey = JSON.stringify([machine.homeId, machine.id, policyController, machine.launch.provider,
        machine.launch.schemaVersion, machine.launch.credentials, machine.preset?.id]);
    const parentControllerAvailable = policyController !== null;
    React.useEffect(() => {
        const binding = props.binding;
        setPolicyParent(null);
        setParentReadFailed(false);
        // Inventory revalidation flips `current` on every Home change; the read is keyed on the resource and its controller, not on that.
        if (!policyController) { setParentReadFailed(true); return; }
        if (!binding?.isCurrent()) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => { abort.abort(); setPolicyParent(null); });
        const timeout = setTimeout(() => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            abort.abort();
            setParentReadFailed(true);
        }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
        void readManagedMachinePolicyParent({ machine, controller: policyController, binding, signal: abort.signal,
            onApprovalPending: registration => approvalRequestRef.current(registration) }).then(result => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            clearTimeout(timeout);
            if (result.kind === 'ready') setPolicyParent(result.parent); else setParentReadFailed(true);
        }).catch(() => {
            // An unavailable parent cannot enable Reset; the live row stays readable and says why it is read-only.
            if (!abort.signal.aborted) { clearTimeout(timeout); setParentReadFailed(true); }
        });
        return () => { clearTimeout(timeout); abort.abort(); retirement.dispose(); };
    }, [props.binding, parentControllerAvailable, parentReadKey, parentReadRevision]);
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
    const operationRefreshThroughAction = React.useRef(false);
    const currentControllerAvailable = requiredController !== null;
    React.useEffect(() => {
        const binding = props.binding;
        if (!props.current || !binding?.isCurrent()) return;
        let current = true;
        const retirement = binding.onRetire(() => { current = false; });
        const shouldContinue = () => current && binding.isCurrent();
        const machineIds = [...new Set([...(currentControllerAvailable ? [machine.controller.machineId] : []),
            ...(machine.enrolledMachineId ? [machine.enrolledMachineId] : [])])];
        const throughAction = operationRefreshThroughAction.current;
        operationRefreshThroughAction.current = false;
        for (const machineId of machineIds) {
            const scope = { serverId: props.serverId, accountId: binding.accountId, machineId };
            const list = throughAction ? async ({ request }: Parameters<NonNullable<Parameters<typeof reconcileActionOperationsOnce>[0]['list']>>[0]) => {
                const result = await props.executeAction('action.operations.list', {
                    serverId: props.serverId, machineId, ...(request ?? {}),
                }, { surface: 'ui', authority: 'present_user', serverId: props.serverId,
                    expectedAccountId: binding.accountId });
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                return ActionOperationListV1ResponseSchema.parse(result.result);
            } : undefined;
            void reconcileActionOperationsOnce({ scope, shouldContinue, requireCurrentDomainFacts: true,
                ...(list ? { list } : {}) }).catch(() => {
                if (shouldContinue()) publishActionOperationObservation({ ...scope, observation: 'unavailable' });
            });
        }
        return () => { current = false; retirement.dispose(); };
    }, [props.binding, props.current, props.serverId, currentControllerAvailable, machine.id,
        machine.controller.machineId, machine.controller.installationId, machine.enrolledMachineId, operationReadRevision]);

    const run = async (actionId: ManagedMachineActionIdV1, input: unknown, onSucceeded?: (result: unknown) => void,
        onFailed?: () => void, reviewedMachineReferences?: ManagedMachineDeleteReview['census']): Promise<boolean> => {
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
                operationRefreshThroughAction.current = true;
                refreshOperation();
                refreshPolicyParent();
            }
            release();
            return true;
        };
        try {
            const result = await props.executeAction(actionId, input, { surface: 'ui', serverId: props.serverId,
                expectedAccountId: binding.accountId, signal: interest.signal,
                ...(reviewedMachineReferences ? { reviewedMachineReferences } : {}) });
            if (!binding.isCurrent() || interest.signal.aborted) return false;
            const outcome = classifyHomeActionOutcome(result);
            if (outcome.kind === 'failed') {
                fail(homeDomainFailureCode(outcome.failure));
                return false;
            }
            if (outcome.kind === 'approval_pending') {
                awaitingApproval = true;
                if (actionId === 'machines.managed.delete') submittedDeleteApprovalIdRef.current = outcome.artifactId;
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
                if (shouldReleaseManagedMachinePendingOnApproval(actionId)) release();
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
        const controller = currentManagedMoveController(controllerMachinesRef.current?.find(row => row.id === id), machine.custodianAccountId,
            props.binding?.isCurrent() ? props.binding.scope : null);
        if (!candidate?.reachable || !controller || !sameStrictJsonValue(controller, candidate.controller)
            || sameStrictJsonValue(controller, machine.controller)) return;
        fireAndForget(run('machines.managed.controller.update', { ...target, expectedIntentRevision: machine.intentRevision,
            controller, reviewedPendingEffects: true }), { tag: 'ManagedMachineSections.move' });
    };
    const inspect = () => fireAndForget(run('machines.managed.inspect', target), { tag: 'ManagedMachineSections.inspect' });
    const reviewDependencies = () => {
        if (pendingDeleteApprovalId) { openApproval(pendingDeleteApprovalId); return; }
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
    const resourceGone = machine.observation?.availability === 'absent' || machine.observation?.storage === 'lost';
    const resourceConfirmedAbsent = machine.allocation === 'confirmed-absent' || machine.observation?.availability === 'absent';
    const canRebuild = canMutate && bound && machine.creationState === 'active' && !resourceGone
        && requiredController !== null && controllerPresence?.online === true && supportedIntents.includes('rebuild');
    const reviewRebuild = () => fireAndForget((async () => {
        const binding = props.binding;
        const interest = interestRef.current;
        if (!canRebuild || !binding?.isCurrent() || !interest || interest.signal.aborted || pendingRef.current) return;
        pendingRef.current = true;
        setPending('machines.provisioners.options');
        setRebuildReview(null);
        setError(null);
        try {
            const result = await readManagedMachineRebuildReview({ machine, binding, signal: interest.signal,
                onApprovalPending: registration => approvalRequestRef.current(registration) });
            if (!binding.isCurrent() || interest.signal.aborted) return;
            if (result.kind === 'failed') setError(result.code);
            else setRebuildReview({ key: rebuildReviewKey, review: result.review });
        } catch {
            if (binding.isCurrent() && !interest.signal.aborted) setError('managed_parent_unavailable');
        } finally {
            if (binding.isCurrent() && !interest.signal.aborted) { pendingRef.current = false; setPending(null); }
        }
    })(), { tag: 'ManagedMachineSections.rebuildReview' });
    // Native controls sit at the receipt's foot, where its cost and recipe state the consequence.
    const receiptActions: NonNullable<ManagedReceiptModel['secondary']> = bound && machine.creationState === 'active' && machine.archivedAt === undefined ? [
        ...managedReceiptPowerIntents(machine, supportedIntents).map(intent => {
            return { label: t(`managedMachines.actions.${intent}`), testID: `managed-machine.${intent}`, tone: 'bordered' as const,
                ...(intent === 'stop' ? { icon: <Icon name="stop" size={14} color={theme.colors.text.primary} /> } : {}),
                disabled: !canMutate || resourceGone, loading: pending === 'machines.managed.power.set',
                onPress: () => fireAndForget(run('machines.managed.power.set', { ...target, when: 'now', expectedRevision: machine.intentRevision,
                    intent }), { tag: 'ManagedMachineSections.power' }) };
        }),
        ...(supportedIntents.includes('rebuild') ? [{ label: t('managedMachines.actions.rebuild'), testID: 'managed-machine.rebuild',
            tone: 'bordered' as const, disabled: !canRebuild,
            loading: pending === 'machines.provisioners.options' || pending === 'machines.managed.rebuild', onPress: reviewRebuild }] : []),
        ...(supportedIntents.includes('delete') ? [{ label: t('managedMachines.actions.delete'), testID: 'managed-machine.delete',
            tone: 'text' as const, disabled: !canMutate && !pendingDeleteApprovalId,
            loading: pending === 'machines.managed.references.get' || pending === 'machines.managed.delete', onPress: reviewDependencies }] : []),
    ] : [];
    const receipt: ManagedReceiptModel = { ...buildManagedConfigurationReceipt({ launch: machine.launch,
        environment: machine.environmentSetup?.environment, reviewedFacts: machine.reviewedFacts,
        providerTitle: provisionerPresentation.title ?? policyParent?.providerTitle ?? t('common.machine'),
        mark: provisionerPresentation.markAt(MANAGED_PROVISIONER_MARK_SIZE.receipt),
        localized: provisionerPresentation.localized,
        homeName: resolveHomeDisplayLabel(getServerProfileById(props.serverId), props.serverId), preset: machine.preset, created: true,
        nativeLifetimePresented: policyParent?.capabilities.finiteOnly === true,
        // The reviewed controller is usually the current one: then it is the same name, pending or read, as the page's.
        controllerName: sameStrictJsonValue(machine.reviewedFacts?.controller ?? machine.controller, machine.controller) ? controllerName
            : controllerNameOrPending(controllerMachines?.find(candidate =>
                candidate.id === (machine.reviewedFacts?.controller ?? machine.controller).machineId
                && candidate.installationId === (machine.reviewedFacts?.controller ?? machine.controller).installationId), controllerMachines),
        credentialPresentations: credentialPresentation.presentationsByKey }),
        // A resource that no longer exists neither runs nor bills: its receipt is only the record of how it was made.
        ...(resourceConfirmedAbsent ? { cost: null } : {}),
        ...(receiptActions.length ? { secondary: receiptActions } : {}) };
    const credentialRowKeys = new Set(managedCredentialReceiptTargets(machine.launch).map(target => target.key));
    const credentialNames = receipt.facts.filter(fact => credentialRowKeys.has(fact.id)).map(fact => fact.value).join(', ');
    const recipeRows = managedRecipeRows(machine, provisionerPresentation.localized);
    const nativeExpiry = machine.observation?.nativeExpiry;
    const nativeExpiryDescription = nativeExpiry !== undefined ? t('managedRetention.nativeExpiry', {
        provider: provisionerPresentation.title ?? policyParent?.providerTitle ?? t('common.machine'), time: formatAsOfTime(nativeExpiry),
    }) : undefined;
    const providerName = provisionerPresentation.title ?? policyParent?.providerTitle;
    const enrolledDaemonState = StoredMachinePublishedDaemonStateV1Schema.safeParse(enrolledMachine?.daemonState);
    // The consequence says what the rule means for the bill, from the provider's own billing facts.
    // A provider that parks by suspending says Suspend, from the same resolver that picks the native intent.
    const parking = retentionParking(supportedIntents);
    const consequence = (retention: MachineRetentionPolicyV1['retention']) => billing && providerName
        ? describeRetentionConsequence(retention, { location: billing.location, stoppedBilling: billing.stoppedBilling, provider: providerName,
            parking, ...(provisionerPresentation.kindTitle ? { kind: provisionerPresentation.kindTitle } : {}) })
        : describeRetention(retention, undefined, parking);
    const creationContext: ManagedCreationContext = { provider: providerName, operation,
        ...(reachabilityScope && enrolledMachine?.installationId ? { enrolledMachine: {
            machineId: enrolledMachine.id, installationId: enrolledMachine.installationId,
            online: describeMachinePresenceLine(enrolledMachine, presenceNowMs, undefined, reachabilityScope).online,
            serviceManaged: enrolledDaemonState.success && enrolledDaemonState.data.serviceManaged === true,
            activeAt: enrolledMachine.activeAt,
        } } : {}),
        providerAvailable: requiredController && provisionerPresentation.projectionReady ? provisionerPresentation.title !== null : undefined,
        ...(controller && controllerPresence && controllerName !== null ? { controller: { name: controllerName, online: controllerPresence.online } } : {}) };
    const keep: ManagedKeepProps = { policy, inherited: false, defaultPolicy: policyParent?.policy,
        finiteOnly: policyParent?.capabilities.finiteOnly,
        capabilitiesAvailable: policyParent !== null,
        // Until the controller answers, the rule is read-only: say who it waits for, or that it is being read.
        unavailableReason: controllerPresence?.online === false ? controllerRequired(controllerName)
            // Checking and its failure read as one calm line each, so the card keeps its height between them.
            : parentReadFailed ? t('managedRetention.waitsForProvider', { provider: providerName ?? t('common.machine') })
                : providerName ? t('managedMachines.options.loading', { provider: providerName }) : undefined,
        nativeExpiry: nativeExpiryDescription,
        effects: supportedMachineRetentionEffectsV1(supportedIntents), parking,
        canWake: isMachineRetainedWakeEligibleV1(policy.retention, { supportedIntents }),
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
    // The installer's open consent is answered on its own task, where the agent answers it too (`tool.systemTasks` respond).
    const promptTaskId = readManagedInstallationPrompt(currentManagedCreationOperation(machine, operation))?.taskId ?? null;
    const answeringRef = React.useRef<string | null>(null);
    const answerPrompt = canMutate && currentControllerAvailable && promptTaskId ? (approved: boolean) => {
        const binding = props.binding;
        if (!binding?.isCurrent() || answeringRef.current === promptTaskId) return;
        answeringRef.current = promptTaskId;
        setError(null);
        fireAndForget(machineCapabilitiesInvoke(machine.controller.machineId, { id: 'tool.systemTasks', method: 'respond',
            params: { taskId: promptTaskId, answer: { approved } } }, { serverId: props.serverId, accountId: binding.accountId })
            .then(result => {
                if (!binding.isCurrent()) return;
                if (!result.supported || !result.response.ok) { answeringRef.current = null; setError('managed_request_failed'); }
            }), { tag: 'ManagedMachineSections.answerPrompt' });
    } : undefined;
    const resourceEnded = resourceConfirmedAbsent;
    const canCancelCreation = !machine.enrolledMachineId && machine.creationState === 'active' && machine.allocation !== 'confirmed-absent';
    const cancelCreation = () => fireAndForget(run('machines.managed.cancel', { ...target, expectedIntentRevision: machine.intentRevision }),
        { tag: 'ManagedMachineSections.cancel' });
    const canCancelCreationRow = canCancelCreation && !describeManagedCreation(machine, creationContext).actions.includes('cancel');
    // Changed here means it differs from the default it would reset to; otherwise say what the rule governs.
    const policyDescription = policyParent && !sameStrictJsonValue(policyParent.policy,
        { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage })
        ? t('managedRetention.changedFor', { name: machineName }) : t('managedRetention.policyDescription');
    return <ManagedReceiptColumns receipt={receipt} compact={compact} testID="managed-machine.detail">
        {pendingDeleteApprovalId
            ? <AttentionBanner testID="managed-machine.approval" tone="neutral"
                title={resolveActionTitle('machines.managed.delete', null)} description={t('approvals.waitingForYou')}
                action={{ label: t('approvals.review'), onPress: () => openApproval(pendingDeleteApprovalId) }} />
            : approvalPresentation?.kind === 'generic' ? <AttentionBanner testID="managed-machine.approval" tone="neutral"
                title={t('approvals.title')} description={t('approvals.status.open')}
                action={{ label: t('approvals.details'), onPress: () => openApproval(approvalPresentation.artifactId) }} />
            : null}
        <ManagedCreationProgress machine={machine} operation={operation} setupRecovery={setupRecovery} provider={providerName}
            enrolledMachine={creationContext.enrolledMachine} title={machineName}
            {...(props.staleRead ? { staleRead: props.staleRead } : {})}
            {...(!pendingDeleteApprovalId ? { reviewApproval: (artifactId: string) => router.push(
                `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(props.serverId)}` as never) } : {})}
            answerPrompt={answerPrompt}
            providerAvailable={creationContext.providerAvailable}
            mark={provisionerPresentation.markAt(MANAGED_PROVISIONER_MARK_SIZE.row)} controller={creationContext.controller} handlers={{ ...(props.current ? { checkNow: inspect } : {}),
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
            ...(canMutate && currentControllerAvailable && canRetryManagedInstallation(machine, operation, creationContext) ? {
                reinstall: () => fireAndForget(run('machines.managed.bootstrap.retry', { ...target,
                    expectedIntentRevision: machine.intentRevision }), { tag: 'ManagedMachineSections.retryInstall' }),
            } : {}) }} />
        <ManagedCreationScopeRuleSection machine={machine} serverId={props.serverId} binding={props.binding} />
        {/* A resource confirmed gone, or a creation canceled, has nothing left to keep; its state row says what remains. */}
        {resourceEnded || machine.creationState !== 'active' ? null : <ManagedMachinePolicySection testID="managed-machine.policy" description={policyDescription} keep={keep}
            compactSummary={compact ? { summary: describeRetention(policy.retention, undefined, parking),
                onPress: () => {
                    closeKeepSheet();
                    keepSheetRef.current = showManagedKeepSheet(keepChannel, 'managed-machine.policy-sheet');
                } } : undefined} />}
        {/* A resource that no longer exists has nothing left to manage; the receipt keeps where it was managed from. */}
        {resourceEnded ? null : requiredController ? <ManagedMachineControllerSection testID="managed-machine.controller"
            description={controllerRequired(controllerName)}
            controller={{ name: controllerName, icon: machineMark, online: controllerPresence!.online,
                presence: controllerPresence!.label, move: billing?.location === 'local' ? { kind: 'fixed' }
                    : canMove ? { kind: 'movable', onPress: () => fireAndForget(reviewMove(), { tag: 'ManagedMachineSections.moveReview' }) }
                        : { kind: 'unavailable' } }} />
            : controllerName === null ? <ItemGroup title={t('managedMachines.config.managedFrom')} description={controllerRequired(null)}>
                <ItemLoadStateRows state={PENDING_READ} rows={1} lines={2} testID="managed-machine.controller.pending" /></ItemGroup>
            : <ItemGroup title={t('managedMachines.config.managedFrom')}><Item title={controllerName}
                subtitle={controllerRequired(controllerName)} mode="info" showChevron={false}
                testID="managed-machine.controller-unavailable" accessoryLayout="adaptive" rightElement={canMove ?
                    <RoundButton title={t('managedController.moveShort')} display="secondary" size="small"
                        testID="managed-machine.controller-unavailable:move"
                        onPress={() => fireAndForget(reviewMove(), { tag: 'ManagedMachineSections.moveReview' })} /> : undefined} /></ItemGroup>}
        {moveReview?.key === deleteReviewKey && canMutate ? <ManagedControllerMoveList testID="managed-machine.move-candidates"
            candidates={moveReview.candidates.map(candidate => {
                const row = controllerMachines?.find(value => value.id === candidate.id);
                const presence = row ? describeMachinePresenceLine(row, presenceNowMs, undefined, reachabilityScope) : null;
                const current = row?.id === machine.controller.machineId && row.installationId === machine.controller.installationId;
                const currentInstallation = currentManagedMoveController(row, machine.custodianAccountId, reachabilityScope);
                const reachable = candidate.reachable && sameStrictJsonValue(currentInstallation, candidate.controller) && currentInstallation !== null;
                return { id: candidate.id, name: getMachineDisplayName(row) ?? candidate.id, icon: machineMark,
                    subtitle: presence?.online && machine.launch.credentials?.length ? t(reachable ? 'managedController.reachableAccount'
                        : 'managedController.unavailableAccount', { account: credentialNames })
                        : presence?.label ?? t('common.unknown'), online: presence?.online ?? false, current, reachable };
            })} onMove={moveController} /> : null}
        {/* A phone reads the receipt right after; the same recipe rows above it would repeat it. */}
        {/* Ended, the receipt beside it is the whole record; the same rows again would only repeat it. */}
        {compact || resourceEnded ? null : <ManagedMachineRecipeSection testID="managed-machine.recipe" rows={recipeRows} />}
        {currentRebuildReview ? <>
            {(['host', 'child'] as const).map(scope => <ItemGroup key={scope} title={t(`managedMachines.rebuildReview.${scope}`)}>
                {currentRebuildReview.effects.map((effect, index) => effect.scope === scope ? <Item key={index}
                    title={effect.title} subtitle={effect.details.join('\n')} subtitleLines={0} mode="info" showChevron={false}
                    testID={`managed-machine.rebuild-effect.${scope}:${index}`} /> : null)}
            </ItemGroup>)}
            <ManagedDecisionRow testID="managed-machine.rebuild-decision" footnote={t('managedMachines.rebuildReview.help')}
                onCancel={canMutate ? () => setRebuildReview(null) : undefined}
                confirm={{ label: t('managedMachines.actions.rebuild'), testID: 'managed-machine.rebuild-confirm', disabled: !canRebuild,
                    loading: pending === 'machines.managed.rebuild', onPress: () => {
                        if (!canRebuild) return;
                        fireAndForget(run('machines.managed.rebuild', { homeId: machine.homeId, managedMachineId: machine.id,
                            expectedRevision: machine.intentRevision, kind: 'rebuild', reviewedEffectDigest: currentRebuildReview.reviewedEffectDigest },
                            () => setRebuildReview(null), () => setRebuildReview(null)), { tag: 'ManagedMachineSections.rebuild' });
                    } }} />
        </> : null}
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
                    fireAndForget(run('machines.managed.delete', input, undefined, undefined, currentDeleteReview.census),
                        { tag: 'ManagedMachineSections.delete' });
                } }} /> : null}
        {/* Remove forgets a resource Delete can no longer end (lab m-life: an ended resource's quiet Remove); a live one keeps Delete. */}
        {canRemove && removeReviewKey !== deleteReviewKey && !describeManagedCreation(machine, creationContext).actions.includes('remove')
            && !receiptActions.some(action => action.testID === 'managed-machine.delete')
            ? <ItemGroup surface="none"><SectionButtonRow testID="managed-machine.remove-row"
                trailing={<RoundButton title={t('managedMachines.actions.remove')} display="secondary" size="small"
                    testID="managed-machine.remove" onPress={reviewRemoval} />}>
                {null}
            </SectionButtonRow></ItemGroup> : null}
        {removeReviewKey === deleteReviewKey ? <ManagedDecisionRow testID="managed-machine.remove-decision"
            footnote={resourceEnded
                ? t('managedCleanup.archiveEnded') : t('managedCleanup.archiveReview')}
            onCancel={canMutate ? () => setRemoveReviewKey(null) : undefined}
            confirm={{ label: t('managedMachines.actions.remove'), testID: 'managed-machine.remove-confirm', disabled: !canRemove,
                loading: pending === 'machines.managed.retire', onPress: () => { if (canRemove) fireAndForget(run('machines.managed.retire', { ...target,
                    expectedIntentRevision: machine.intentRevision, manualResponsibility: true }), { tag: 'ManagedMachineSections.remove' }); } }} /> : null}
        {/* An offline controller's banner already carries Cancel; the closing row would say it twice. */}
        {/* A bound resource exists: canceling deletes it. Only a submitted, unbound create may or may not need cleanup. */}
        {canCancelCreationRow ? <ManagedDecisionRow testID="managed-machine.cancel-decision" footnote={machine.allocation === 'bound'
            ? t('managedMachines.detail.cancelDescriptionBound') : t('managedMachines.detail.cancelDescription')}
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
export function useManagedEnrolledMachine(props: Readonly<{ enrolledMachineId: string | undefined; serverId: string; executeAction?: Execute }>): ManagedEnrolledMachine {
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
export type ManagedEnrolledMachine = {
    serverId: string;
    inventory: ReturnType<typeof useManagedMachineInventory>;
    entry: ManagedMachineInventoryEntry | undefined;
    machine: ManagedMachineV1 | undefined;
    executeAction: Execute;
    deny: () => void;
};

export function ManagedEnrolledMachineSections(props: Readonly<{ enrolledMachineId: string; serverId: string; executeAction?: Execute }>) {
    return <ManagedEnrolledMachineSectionsView enrolled={useManagedEnrolledMachine(props)} />;
}

export function ManagedEnrolledMachineSectionsView(props: Readonly<{ enrolled: ManagedEnrolledMachine }>) {
    const { serverId, inventory, entry, machine, executeAction, deny } = props.enrolled;
    const readApproval = <ManagedMachineReadApprovalNotice serverId={serverId} entry={entry} />;
    if (!machine) return readApproval;
    return <>
        {readApproval}
        {/* A failed re-read is said once, on the state row's freshness; a re-read in flight keeps the last answer quietly. */}
        <ManagedMachineSections key={JSON.stringify([serverId, machine.id])} machine={machine} serverId={serverId}
            binding={inventory.bindings.get(serverId)} current={entry?.status === 'ready'} executeAction={executeAction}
            onChanged={inventory.refresh} onDenied={deny}
            {...(entry?.status === 'error' || entry?.status === 'unsupported' ? { staleRead: { retry: inventory.refresh } } : {})} />
    </>;
}

export type ManagedMachineHeaderIdentity = Readonly<{
    name: string;
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
 * real facts only: power from the provider's own observation and how long it has been running only
 * when the caller knows when it came up. Native resource identities stay in Details, so a generated
 * guest hostname never competes with the machine's own name.
 */
export function managedMachineHeaderMeta(input: Readonly<{
    machine: Readonly<{ observation?: ManagedMachineV1['observation']; resource?: Readonly<{ value: unknown }> }>;
    provider: string | null; kindTitle: string | null;
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
        meta.push({ key: 'managed-kind', text: kind });
    }
    return meta;
}

/**
 * Who a created machine is, for its page header (lab `m-detail`): the provider's mark, where it came
 * from ("Made from the Build box preset."), and its observed power, uptime and kind beside the
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
        runningSince: live?.runningSince, now: Date.now() });
    return { name: machine.launch.name, mark: presentation.mark,
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
            // The way back and the decision are one pair: together at the row's end, the irreversible one last.
            trailing={<>
                {props.onCancel ? <RoundButton title={t('common.cancel')} display="inverted" size="small" textStyle={Typography.default()}
                    testID={`${props.testID}.cancel`} onPress={props.onCancel} /> : null}
                <RoundButton title={props.confirm.label} display="destructive" size="small" testID={props.confirm.testID}
                    disabled={props.confirm.disabled} loading={props.confirm.loading} onPress={props.confirm.onPress} />
            </>}>
            {null}
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
