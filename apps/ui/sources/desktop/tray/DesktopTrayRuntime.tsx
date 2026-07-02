import * as React from 'react';

import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { applyTauriTrayState } from './applyTauriTrayState';
import { buildDesktopTrayState } from './buildDesktopTrayState';

function TauriDesktopTrayRuntime(): React.ReactElement | null {
    const connectionHealth = useConnectionHealth();
    const relayDriftBanner = useRelayDriftBanner();

    const trayState = React.useMemo(() => buildDesktopTrayState({
        health: {
            kind: connectionHealth.kind,
            machineCount: connectionHealth.machineCount,
            onlineCount: connectionHealth.onlineCount,
            statusLabelKey: connectionHealth.statusLabelKey,
            machineLabelKey: connectionHealth.machineLabelKey,
        },
        relayDriftBannerTitle: relayDriftBanner?.title ?? null,
        t,
    }), [
        connectionHealth.kind,
        connectionHealth.machineCount,
        connectionHealth.machineLabelKey,
        connectionHealth.onlineCount,
        connectionHealth.statusLabelKey,
        relayDriftBanner?.title,
    ]);

    React.useEffect(() => {
        fireAndForget(applyTauriTrayState(trayState), {
            tag: 'DesktopTrayRuntime.applyTauriTrayState',
        });
    }, [trayState]);

    return null;
}

export function DesktopTrayRuntime(): React.ReactElement | null {
    if (!isTauriDesktop()) return null;
    return <TauriDesktopTrayRuntime />;
}
