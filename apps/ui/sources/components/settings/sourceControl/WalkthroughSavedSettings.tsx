import * as React from 'react';
import type { ScmDiffSummaryResultListResponse } from '@happier-dev/protocol/scm';
import { Modal } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { SOURCE_CONTROL_SETTINGS } from './sourceControlSettings';
import { createScmDiffSummarySavedResultOperations } from '@/sync/ops/scmDiffSummary/savedResultOperations';
import { deleteSavedScmDiffSummaryResults } from '@/sync/ops/scmDiffSummary/generate';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { t } from '@/text';

/** A live projection of the owning machine's saved store and retained run records, never a second store. */
export function WalkthroughSavedSettings(props: Readonly<{
    machineId: string | null; serverId: string | null; machineName: string;
    prepareAfterTurn: boolean; onPrepareAfterTurn: (value: boolean) => void;
    modelAvailable: boolean;
}>) {
    const binding = useServerCredentialAccountScopeBinding(props.serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const key = JSON.stringify([scope?.serverId, scope?.accountId, props.machineId]);
    const currentKey = React.useRef(key); currentKey.current = key;
    const [data, setData] = React.useState<Readonly<{ key: string; inventory: ScmDiffSummaryResultListResponse }> | null>(null);
    const [clearing, setClearing] = React.useState(false);
    const [clearFailed, setClearFailed] = React.useState(false);
    const operation = React.useRef<Readonly<{ key: string; ops: ReturnType<typeof createScmDiffSummarySavedResultOperations> }> | null>(null);
    React.useEffect(() => {
        setClearFailed(false); setClearing(false);
        if (!binding || !scope || !props.machineId) { operation.current = null; return; }
        const abort = new AbortController();
        const current = () => !abort.signal.aborted && binding.isCurrent() && currentKey.current === key;
        const retired = binding.onRetire(() => abort.abort());
        const ops = createScmDiffSummarySavedResultOperations({ machineId: props.machineId, serverId: scope.serverId,
            accountId: scope.accountId, signal: abort.signal, shouldContinue: current,
        });
        operation.current = { key, ops };
        void ops.list().then(inventory => { if (current()) setData({ key, inventory }); });
        return () => { abort.abort(); retired.dispose(); if (operation.current?.key === key) operation.current = null; };
    }, [binding, key, props.machineId, scope?.serverId, scope?.accountId]);
    const inventory = data?.key === key ? data.inventory : null;
    const available = inventory?.success === true ? inventory : null;
    const cost = available?.sevenDayCost;
    const costText = cost && cost.status !== 'unavailable' && typeof cost.estimatedUsd === 'number'
        ? t('walkthroughSettings.cost', { amount: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cost.estimatedUsd), partial: cost.status === 'partial' })
        : t('walkthroughSettings.costUnavailable');
    const clear = async () => {
        const captured = operation.current;
        if (!captured || captured.key !== key || !available || !scope || !binding?.isCurrent() || clearing) return;
        const confirmed = await Modal.confirm(t('walkthroughSettings.clearTitle'), t('walkthroughSettings.clearDescription', { machine: props.machineName }),
            { destructive: true, confirmText: t('walkthroughSettings.clear') });
        if (!confirmed || !binding.isCurrent() || currentKey.current !== key) return;
        setClearing(true); setClearFailed(false);
        try {
            const result = await captured.ops.clear({ results: available.results.map(item => ({ cwd: item.cwd,
                resultId: item.resultId, expectedRevision: item.revision, comparisonId: item.comparisonId,
                ...(item.sessionId ? { sessionId: item.sessionId } : {}) })) });
            if (!binding.isCurrent() || currentKey.current !== key) return;
            if (result.success) deleteSavedScmDiffSummaryResults(scope, result.deleted.map(item => item.resultId));
            setClearFailed(!result.success || result.failures.length > 0 || result.deleted.some(item => item.marksCleanup?.success === false));
            const refreshed = await captured.ops.list();
            if (binding.isCurrent() && currentKey.current === key) setData({ key, inventory: refreshed });
        } finally { if (binding.isCurrent() && currentKey.current === key) setClearing(false); }
    };
    return <>
        <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.prepareAfterTurn} showChevron={false} subtitleLines={0}
            subtitle={`${t('walkthroughSettings.prefetchDescription')}\n${props.modelAvailable ? costText : `${t('walkthroughSettings.chooseModel')} · ${costText}`}`}
            rightElement={<Switch value={props.prepareAfterTurn} disabled={!props.prepareAfterTurn && !props.modelAvailable}
                onValueChange={value => { if (!value || props.modelAvailable) props.onPrepareAfterTurn(value); }} />}
            onPress={() => { if (props.prepareAfterTurn || props.modelAvailable) props.onPrepareAfterTurn(!props.prepareAfterTurn); }} />
        <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.savedWalkthroughs} showChevron={false} subtitleLines={0}
            subtitle={clearFailed ? t('walkthroughSettings.clearFailed') : available
                ? t('walkthroughSettings.savedCount', { count: available.count, bytes: formatByteSize(available.bytes) })
                : t('walkthroughSettings.unavailableData')}
            rightElement={available?.count === 0 ? null : <RoundButton title={t('walkthroughSettings.clear')} size="small" display="destructive"
                testID="settings.sourceControl.savedWalkthroughs.clear" disabled={!available || clearing}
                loading={clearing} onPress={() => { void clear(); }} />} />
    </>;
}
