import type {
    ConnectionHealthKind,
    ConnectionHealthMachineLabelKey,
    ConnectionHealthStatusLabelKey,
} from '@/components/navigation/connectionStatus/connectionHealthTypes';

export type DesktopTrayState = Readonly<{
    status: ConnectionHealthKind | 'attention_required';
    label: string;
    detail: string;
}>;

export function buildDesktopTrayState(params: Readonly<{
    health: Readonly<{
        kind: ConnectionHealthKind;
        machineCount: number;
        onlineCount: number;
        statusLabelKey: ConnectionHealthStatusLabelKey;
        machineLabelKey: ConnectionHealthMachineLabelKey;
    }>;
    relayDriftBannerTitle?: string | null;
    t: (key: ConnectionHealthStatusLabelKey | ConnectionHealthMachineLabelKey) => string;
}>): DesktopTrayState {
    const driftTitle = typeof params.relayDriftBannerTitle === 'string'
        ? params.relayDriftBannerTitle.trim()
        : '';
    if (params.health.kind === 'healthy' && driftTitle) {
        return {
            status: 'attention_required',
            label: params.t('status.actionRequired'),
            detail: driftTitle,
        };
    }

    const label = params.t(params.health.statusLabelKey);
    const machineLabel = params.t(params.health.machineLabelKey);
    const showCounts = params.health.machineCount > 0;

    return {
        status: params.health.kind,
        label,
        detail: showCounts ? `${machineLabel} · ${params.health.onlineCount}/${params.health.machineCount}` : machineLabel,
    };
}
