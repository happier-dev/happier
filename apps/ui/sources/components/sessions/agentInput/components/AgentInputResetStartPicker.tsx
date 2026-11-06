import * as React from 'react';
import { View } from 'react-native';
import type { PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useUsageWidgetModel } from '@/components/settings/usage/widgets/usageWidgetBatch';
import { useUsagePlans } from '@/components/settings/usage/widgets/plans/useUsagePlans';
import { resolveUsageResetStartBinding } from '@/components/settings/usage/widgets/plans/usagePlansModel';
import { formatPlanMoment } from '@/components/settings/usage/widgets/plans/UsagePlanParts';
import { t } from '@/text';

type Props = Readonly<{
    sessionId: string;
    serverId: string;
    onSelect(reset: PendingResetStartBindingV1): void;
}>;

/** Mounted only after explicit composer intent; the shared Usage Resource owns quota demand. */
export default function AgentInputResetStartPicker(props: Props) {
    const { model } = useUsageWidgetModel({ session: props.sessionId, includeQuotaHistory: true }, 'usage_capacity');
    const slice = model.shownQuery?.authority.serverId === props.serverId ? model.slice : null;
    return <View testID="agent-input-reset-start-picker">
        {slice ? <ResetStartOptions {...props} slice={slice} resource={model} />
            : model.pending ? <ItemLoadStateRows state={{ kind: 'loading' }} rows={3} lines={2} shape="list"
                accessibilityLabel={t('usage.board.page.loading')} />
                : <SurfaceStateCard kind={model.error ? 'error' : 'unavailable'} layout="inline" size="line"
                    title={t('usage.board.plans.resetStartTitle')}
                    reason={t(model.error ? 'usage.board.page.readFailedReason' : 'usage.board.plans.resetStartNoReading')}
                    {...(model.error ? { action: { label: t('common.retry'), onPress: model.refresh } } : {})} />}
    </View>;
}

function ResetStartOptions(props: Props & Readonly<{
    slice: UsageQueryResultSlice;
    resource: Readonly<{ refreshing: boolean; refresh(): Promise<void> }>;
}>) {
    const plans = useUsagePlans(props.slice, props.resource.refresh);
    const actions = plans.projection.accounts.flatMap(account => account.windows.flatMap(window => {
        const binding = resolveUsageResetStartBinding(account, window.meterId, plans.nowMs);
        if (binding.status !== 'available' || window.resetAtMs === null) return [];
        const name = plans.nameOf(account);
        return [{ id: window.key, testID: `agent-input-reset-start-option.${window.key}`,
            label: `${name.title} · ${window.label}`,
            subtitle: [name.qualifier, t('usage.board.plans.capacityResets', {
                time: formatPlanMoment(window.resetAtMs, plans.nowMs),
            })].filter(Boolean).join(' · '),
            onPress: () => {
                // Selection can outlive its displayed reading; only the shared admission owner decides.
                const current = resolveUsageResetStartBinding(account, window.meterId, Date.now());
                if (current.status === 'available') props.onSelect(current.reset);
            } }];
    }));
    return actions.length ? <ActionListSection title={t('usage.board.plans.sendAtReset')} actions={actions} />
        : <SurfaceStateCard kind="unavailable" layout="inline" size="line"
            title={t('usage.board.plans.resetStartTitle')} reason={t('usage.board.plans.resetStartNoReset')} />;
}
