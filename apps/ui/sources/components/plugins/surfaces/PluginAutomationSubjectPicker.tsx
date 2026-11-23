import * as React from 'react';
import type { AutomationSubjectPickerProps } from '@happier-dev/plugin-ui/components';
import { HappierAutomationSubjectPicker } from '@happier-dev/plugin-ui/presentation';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { PluginUiAutomationPresentationScope } from './pluginUiPrivatePresentationHost';
import { useAutomationSubjectPicker, type AutomationSubjectPickerInput } from '@/sync/domains/workflows/useAutomationSubjectPicker';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { pluginUiSections, PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getPluginSurfaceTargetAuthorityKey } from './pluginSurfaceContext';
import { t } from '@/text';

export type PluginAutomationSubjectPickerProps = AutomationSubjectPickerProps & PluginUiAutomationPresentationScope;

const EMPTY_SUBJECT_KINDS = Object.freeze([]);

/** The physical plugin host lends its Account and Action context to the shared picker. */
export function PluginAutomationSubjectPicker(props: PluginAutomationSubjectPickerProps) {
    const [open, setOpen] = React.useState(false);
    const [refreshKey, retryProjection] = React.useReducer(value => value + 1, 0);
    const targetKey = getPluginSurfaceTargetAuthorityKey(props.target);
    const sessionId = props.target.kind === 'session' ? props.target.sessionId : null;
    const serverId = props.accountLifetime?.scope.serverId;
    const sessionMachineId = getStorage()(React.useCallback(state => sessionId && serverId
        ? resolveMachineControlTargetForSessionFromState(state, { sessionId, serverId })?.machineId ?? null : null,
    [sessionId, serverId]));
    const checkout = props.target.kind === 'project' ? props.target.checkout
        : props.target.kind === 'services' ? props.target.project?.checkout : undefined;
    const actionTarget = props.context?.externalActionTarget;
    const machineId = actionTarget?.kind === 'machine' ? actionTarget.machineId
        : props.target.kind === 'machine' ? props.target.machineId : checkout?.machineId ?? sessionMachineId;
    const plugin = props.kind.kind === 'plugin';
    const demanded = open && props.disabled !== true && props.isCurrent();
    const projection = useDaemonMergedProjectionInputs({ accountLifetime: props.accountLifetime, machineId, serverId,
        sections: plugin ? pluginUiSections(props.kind.pluginId) : PLUGIN_UI_SECTIONS,
        enabled: demanded && plugin, retainInputsAcrossScopeChange: false, refreshKey });
    const subjectKinds = React.useMemo(() => projection.phase === 'ready'
        ? Object.values(projection.inputs?.pluginUiProjection.subjectKindsById ?? {}) : EMPTY_SUBJECT_KINDS,
    [projection.phase, projection.inputs?.pluginUiProjection.subjectKindsById]);
    // A target replacement retires the existing reader session even if its Account remains the same.
    const context = React.useMemo(() => ({
        ...(machineId ? { externalActionTarget: { kind: 'machine' as const, machineId } } : {}),
        ...props.context,
    }), [props.context, targetKey, machineId]);
    const common = { lifetime: props.accountLifetime, demanded: demanded && (!plugin || projection.phase === 'ready'), context };
    let input: AutomationSubjectPickerInput;
    if (props.kind.kind === 'plugin') {
        const demand = props as Extract<AutomationSubjectPickerProps, { kind: { kind: 'plugin' } }>;
        input = { ...common, kind: demand.kind, page: demand.page ?? {}, subjectKinds };
    } else if (props.kind.kind === 'healthCheck') {
        const demand = props as Extract<AutomationSubjectPickerProps, { kind: { kind: 'healthCheck' } }>;
        input = { ...common, kind: demand.kind, page: demand.page ?? {} };
    } else if (props.kind.kind === 'app') {
        const demand = props as Extract<AutomationSubjectPickerProps, { kind: { kind: 'app' } }>;
        input = { ...common, kind: demand.kind, ...demand.page };
    } else input = { ...common, kind: props.kind };
    const read = useAutomationSubjectPicker(input);
    const current = React.useRef({ targetKey, machineId, lifetime: props.accountLifetime });
    current.current = { targetKey, machineId, lifetime: props.accountLifetime };
    const waiting = read.status === 'loading' || read.status === 'loading_more'
        || plugin && demanded && Boolean(machineId) && (projection.phase === 'idle' || projection.phase === 'loading');
    const failed = read.status === 'error' || plugin && projection.phase === 'error';
    const canSelect = React.useCallback(() => current.current.targetKey === targetKey && current.current.machineId === machineId
        && current.current.lifetime === props.accountLifetime && props.isCurrent() && props.accountLifetime?.isCurrent() === true && !props.disabled,
    [targetKey, machineId, props.accountLifetime, props.isCurrent, props.disabled]);
    const retry = React.useCallback(() => {
        if (plugin && projection.phase === 'error') retryProjection();
        else void read.reload();
    }, [plugin, projection.phase, read.reload]);
    const unavailable = props.accountLifetime === null || !props.isCurrent() || (props.kind.kind === 'database' && read.status === 'idle')
        || plugin && (!machineId || projection.phase === 'unsupported');
    return <HappierAutomationSubjectPicker Menu={DropdownMenu} testID={props.testID} open={open} onOpenChange={setOpen}
        value={props.value} options={read.items} subjectKey={automationSubjectKeyV1} waiting={waiting} failed={failed}
        hasMore={read.hasMore} disabled={props.disabled} canSelect={canSelect} onRetry={retry} onLoadMore={read.loadMore}
        onChange={props.onChange} chooseLabel={t('common.choose')} emptyLabel={t(unavailable ? 'common.unavailable' : 'common.noMatches')}
        loadingLabel={t('common.loading')} retryLabel={t('common.retry')} failureLabel={t('common.requestFailed')} moreLabel={t('common.more')} />;
}
