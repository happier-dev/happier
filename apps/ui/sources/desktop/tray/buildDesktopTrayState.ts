import type {
    ConnectionHealthKind,
    ConnectionHealthMachineLabelKey,
    ConnectionHealthStatusLabelKey,
} from '@/components/navigation/connectionStatus/connectionHealthTypes';

export type DesktopTrayStatus =
    | 'healthy'
    | 'attention_required'
    | 'connecting'
    | 'server_unreachable'
    | 'auth_required'
    | 'server_error'
    | 'no_machine'
    | 'machine_offline';

export type DesktopTrayState = Readonly<{
    status: DesktopTrayStatus;
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
    const status = params.health.kind === 'machine_not_ready'
        ? 'attention_required'
        : params.health.kind;

    return {
        status,
        label,
        detail: showCounts ? `${machineLabel} · ${params.health.onlineCount}/${params.health.machineCount}` : machineLabel,
    };
}
