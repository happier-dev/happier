import * as React from 'react';
import type { ScmDiffSummaryMarksCleanupFailure, ScmDiffSummaryResultListResponse } from '@happier-dev/protocol/scm';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { Switch } from '@/components/ui/forms/Switch';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { SOURCE_CONTROL_SETTINGS } from './sourceControlSettings';
import { createScmDiffSummarySavedResultOperations } from '@/sync/ops/scmDiffSummary/savedResultOperations';
import { isScmActionNotRun, normalizeUiScmFacadeResult } from '@/sync/ops/scm/scmActionInvocation';
import { deleteSavedScmDiffSummaryResults } from '@/sync/ops/scmDiffSummary/generate';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import type { MachineAdministrationTargetStateV1 } from '@/sync/domains/machines/administration/targetSelection';

/** A live projection of the owning machine's saved store and retained run records, never a second store. */
export function WalkthroughSavedSettings(props: Readonly<{
    machineId: string | null; serverId: string | null; machineName: string;
    prepareAfterTurn: boolean; onPrepareAfterTurn: (value: boolean) => void;
    modelAvailable: boolean;
    machineAvailability: MachineAdministrationTargetStateV1['kind'];
}>) {
    const binding = useServerCredentialAccountScopeBinding(props.serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const execution = useMountedActionExecution(scope, { retainInvocation: true });
    const execute = React.useRef(execution.execute); execute.current = execution.execute;
    const key = JSON.stringify([scope?.serverId, scope?.accountId, props.machineId]);
    const currentKey = React.useRef(key); currentKey.current = key;
    const [data, setData] = React.useState<Readonly<{ key: string; inventory: ScmDiffSummaryResultListResponse }> | null>(null);
    const [clearing, setClearing] = React.useState(false);
    const [clearFailed, setClearFailed] = React.useState(false);
    const [cleanup, setCleanup] = React.useState<Readonly<{ key: string; failures: readonly ScmDiffSummaryMarksCleanupFailure[] }> | null>(null);
    const [loadingKey, setLoadingKey] = React.useState<string | null>(null);
    const operation = React.useRef<Readonly<{ key: string; ops: ReturnType<typeof createScmDiffSummarySavedResultOperations> }> | null>(null);
    React.useEffect(() => {
        setClearFailed(false); setClearing(false);
        setCleanup(previous => previous?.key === key ? previous : null);
        if (!binding || !scope || !execution.ready || !props.machineId || props.machineAvailability !== 'online') { operation.current = null; return; }
        const abort = new AbortController();
        const current = () => !abort.signal.aborted && binding.isCurrent() && currentKey.current === key;
        const retired = binding.onRetire(() => abort.abort());
        const ops = createScmDiffSummarySavedResultOperations({ machineId: props.machineId, serverId: scope.serverId,
            accountId: scope.accountId, signal: abort.signal, shouldContinue: current,
            actionExecutor: createFrontDoorActionExecute({ execute: (actionId, input, context) => execute.current(actionId, input, {
                ...(context?.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
                ...(context?.externalActionTarget ? { externalActionTarget: context.externalActionTarget } : {}),
                ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
                ...(context?.signal ? { signal: context.signal } : {}),
            }) }),
        });
        operation.current = { key, ops };
        setLoadingKey(key);
        void ops.list({ includeUsage: true }).then(inventory => { if (current()) { setData({ key, inventory }); setLoadingKey(null); } });
        return () => { abort.abort(); retired.dispose(); if (operation.current?.key === key) operation.current = null; };
    }, [binding, execution.ready, key, props.machineId, props.machineAvailability, scope?.serverId, scope?.accountId]);
    const inventory = data?.key === key ? data.inventory : null;
    const available = inventory?.success === true ? inventory : null;
    const cleanupFailures = cleanup?.key === key ? cleanup.failures : [];
    const cost = available?.sevenDayCost;
    const costText = cost && cost.status !== 'unavailable' && typeof cost.estimatedUsd === 'number'
        ? t('walkthroughSettings.cost', { amount: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cost.estimatedUsd), partial: cost.status === 'partial' })
        : available ? t('walkthroughSettings.costUnavailable') : null;
    const retry = async () => {
        const captured = operation.current;
        if (!captured || captured.key !== key || !binding?.isCurrent()) return;
        setLoadingKey(key);
        const inventory = await captured.ops.list({ includeUsage: true });
        if (operation.current === captured && binding.isCurrent() && currentKey.current === key) {
            setData({ key, inventory }); setLoadingKey(null);
        }
    };
    const offline = props.machineAvailability === 'offline';
    const targetUnavailable = props.machineAvailability !== 'online' && !offline;
    const loading = !offline && (!inventory || loadingKey === key);
    // Without a usable machine there is nothing to list or clear: a chosen one is waited for by name, otherwise the
    // header chip is the recovery.
    const noMachine = targetUnavailable || !props.machineId;
    const clear = async () => {
        const captured = operation.current;
        if (!captured || captured.key !== key || !available || !scope || !binding?.isCurrent() || clearing) return;
        setClearing(true); setClearFailed(false);
        try {
            const result = await captured.ops.clear({ results: available.results.map(item => ({ cwd: item.cwd,
                resultId: item.resultId, expectedRevision: item.revision, comparisonId: item.comparisonId,
                ...(item.sessionId ? { sessionId: item.sessionId } : {}) })) });
            if (!binding.isCurrent() || currentKey.current !== key) return;
            if (isScmActionNotRun(normalizeUiScmFacadeResult(result))) return;
            if (result.success) {
                deleteSavedScmDiffSummaryResults(scope, result.deleted.map(item => item.resultId));
                const failures = result.failures.filter((failure): failure is ScmDiffSummaryMarksCleanupFailure => failure.errorCode === 'reviewed_marks_cleanup_failed');
                setCleanup(previous => ({ key, failures: [...(previous?.key === key ? previous.failures : []), ...failures] }));
            }
            setClearFailed(!result.success || result.failures.some(failure => failure.errorCode !== 'reviewed_marks_cleanup_failed'));
            const refreshed = await captured.ops.list({ includeUsage: false });
            if (binding.isCurrent() && currentKey.current === key) setData({ key,
                inventory: refreshed.success && available.sevenDayCost
                    ? { ...refreshed, sevenDayCost: available.sevenDayCost } : refreshed });
        } finally { if (binding.isCurrent() && currentKey.current === key) setClearing(false); }
    };
    const retryMarksCleanup = async () => {
        const captured = operation.current;
        if (!captured || captured.key !== key || !binding?.isCurrent() || clearing || cleanupFailures.length === 0) return;
        setClearing(true);
        try {
            const remaining: ScmDiffSummaryMarksCleanupFailure[] = [];
            for (const failure of cleanupFailures) {
                const result = await captured.ops.retryMarksCleanup(failure);
                if (!binding.isCurrent() || currentKey.current !== key) return;
                if (!result.success) remaining.push(failure);
            }
            setCleanup({ key, failures: remaining });
        } finally { if (binding.isCurrent() && currentKey.current === key) setClearing(false); }
    };
    return <>
        <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.prepareAfterTurn} showChevron={false} subtitleLines={0}
            subtitle={[t('walkthroughSettings.prefetchDescription'), props.modelAvailable ? null : t('walkthroughSettings.chooseModelFirst'), costText].filter(Boolean).join('\n')}
            rightElement={<Switch value={props.prepareAfterTurn} disabled={!props.prepareAfterTurn && !props.modelAvailable}
                onValueChange={value => { if (!value || props.modelAvailable) props.onPrepareAfterTurn(value); }} />}
            onPress={() => { if (props.prepareAfterTurn || props.modelAvailable) props.onPrepareAfterTurn(!props.prepareAfterTurn); }} />
        <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.savedWalkthroughs} showChevron={false} subtitleLines={0}
            subtitle={offline ? t('walkthroughSettings.unavailableData') : noMachine ? (props.machineAvailability === 'unselected' || !props.machineName ? t('walkthroughSettings.chooseMachine') : t('walkthroughSettings.waitingMachine', { machine: props.machineName })) : cleanupFailures.length > 0 ? t('walkthroughSettings.clearMarksCleanupFailed') : clearFailed ? t('walkthroughSettings.clearFailed') : available
                ? t('walkthroughSettings.savedCount', { count: available.count, bytes: formatHappierDataBytes(available.bytes, { kind: 'storage' }) })
                : loading ? t('common.loading') : t('walkthroughSettings.loadFailed')}
            rightElement={noMachine ? null : cleanupFailures.length > 0 ? <RoundButton title={t('common.retry')} size="small" display="secondary"
                testID="settings.sourceControl.savedWalkthroughs.retryMarksCleanup" disabled={clearing || offline}
                loading={clearing} onPress={() => { void retryMarksCleanup(); }} /> : !offline && !loading && inventory?.success === false ? <RoundButton title={t('common.retry')} size="small" display="secondary"
                testID="settings.sourceControl.savedWalkthroughs.retry" onPress={() => { void retry(); }} /> : !available || available.count === 0 ? null : <RoundButton title={t('walkthroughSettings.clear')} size="small" display="destructive"
                testID="settings.sourceControl.savedWalkthroughs.clear" disabled={clearing || offline}
                loading={clearing} onPress={() => { void clear(); }} />} />
    </>;
}
