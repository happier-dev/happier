import * as React from 'react';

import { useOptionalDetailsTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { fetchSimulatorPreviewSnapshotViaMachineRpc } from '@/sync/domains/devices/simulator/machineRpc';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

import { createSimulatorPreviewDetailsTab } from './simulatorPreviewDetailsTab';

/**
 * The one way to open a Session's simulator preview: its Details tab, which the Session details
 * runtime fills for the Session's Machine. Offered only while the Home's `devices.simulatorPreview`
 * decision is enabled and that Machine's daemon snapshot lists a simulator; otherwise null, so no
 * caller renders an entry that cannot land. The menu's existing open state admits each snapshot
 * read, keeping the last answer while closed and while the next opening asks again.
 */
export function useOpenSessionSimulatorPreview(
    input: Readonly<{
        sessionId: string;
        serverId: string | null;
        active: boolean;
    }>,
): Readonly<{ open: () => void }> | null {
    const serverId = usePreferredServerIdForSession({ sessionId: input.sessionId, serverId: input.serverId });
    const machineId = useSessionMachineTarget(input.sessionId, serverId)?.machineId ?? null;
    const featureScope = React.useMemo(() => (
        serverId ? { scopeKind: 'spawn' as const, serverId } : { scopeKind: 'runtime' as const }
    ), [serverId]);
    const featureEnabled = useFeatureDecision('devices.simulatorPreview', featureScope)?.state === 'enabled';
    const admitted = featureEnabled && machineId !== null;
    const machineKey = admitted ? JSON.stringify([serverId, machineId]) : null;
    // The daemon's last answer for this Machine; another Machine's answer never carries over.
    const [listed, setListed] = React.useState<Readonly<{ machineKey: string; hasSimulator: boolean }> | null>(null);
    React.useEffect(() => {
        if (!input.active || !machineKey || !machineId) return;
        const controller = new AbortController();
        void fetchSimulatorPreviewSnapshotViaMachineRpc({ machineId, serverId, signal: controller.signal }).then((result) => {
            if (controller.signal.aborted) return;
            const hasSimulator = result.ok && result.snapshot.resources.length > 0;
            setListed((previous) => previous?.machineKey === machineKey && previous.hasSimulator === hasSimulator
                ? previous : { machineKey, hasSimulator });
        });
        return () => controller.abort();
    }, [machineId, machineKey, serverId, input.active]);

    const openDetailsTab = useOptionalDetailsTabOpener(
        useDestinationPaneScopeId(createSessionPaneScopeId(input.sessionId, serverId ?? undefined)),
    );
    const usable = machineKey !== null && listed?.machineKey === machineKey && listed.hasSimulator && openDetailsTab !== null;
    const open = React.useCallback(() => {
        openDetailsTab?.(createSimulatorPreviewDetailsTab({ title: t('simulatorPreview.title') }), { intent: 'pinned' });
    }, [openDetailsTab]);
    useCurrentUiContextLocalCommands(usable ? [{ key: 'simulator.open', title: t('simulatorPreview.title'), invoke: open }] : [],
        { contextKey: JSON.stringify([input.sessionId, machineKey]) });
    return React.useMemo(() => usable ? { open } : null, [open, usable]);
}
