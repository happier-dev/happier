import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { PluginUiSurfaceNoticeContext } from '@happier-dev/plugin-ui/advanced';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useClaimableSurfaceNotice } from '@/components/ui/surfaces/claimableSurfaceNotice';
import { WidgetFrameBodyNoticeContext, type WidgetFrameBodyNoticeSource } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { MACHINES_ADD_ROUTE } from '@/components/settings/machines/collection/machineCollectionModel';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageSubscriptionScope } from '@/sync/domains/state/storageSubscriptions';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { t } from '@/text';

/**
 * Says once that the Machine a widget runs on cannot be reached — naming it and the way out — once the
 * mounted body has been refused a Machine-owned call, and keeps the rest of the body usable. The mount
 * that refused lends how to word it (`useBoundPluginSurfaceController`); the wording is read again
 * whenever the stores change, so the Machine's name fills in and the notice leaves when the Machine
 * answers. A plugin's own failure state for that part (plugin-ui `ErrorState`, a failed `SurfaceState`)
 * claims the sentence and says it in its own place with its own action, so only the part that needed
 * the Machine changes; while nothing claims it (an optional part failed quietly), the host says it as
 * one line above the body, with one action, Retry, which asks the body afresh. When no Machine exists at
 * all, retrying cannot help, so the one action is the way forward — adding a machine, or opening the plugin when machines exist but none runs it — in either place.
 */
/** The surrounding surface already presents the Machines card's add recovery. */
export const WidgetMachineAddRecoveryContext = React.createContext(false);

export function WidgetMachineNoticeBoundary(props: Readonly<{ testID: string; children: React.ReactNode }>): React.ReactElement {
    const surroundingAddRecovery = React.useContext(WidgetMachineAddRecoveryContext);
    const [source, setSource] = React.useState<WidgetFrameBodyNoticeSource | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const lend = React.useCallback((next: WidgetFrameBodyNoticeSource | null) => setSource(() => next), []);
    const retry = React.useCallback(() => {
        setSource(null);
        setAttempt((current) => current + 1);
    }, []);
    const router = useRouter();
    // Primitive selections keep each snapshot stable by value while the stores change.
    const sentence = storage(() => source?.()?.sentence ?? null, MACHINE_NOTICE_INPUTS);
    const addMachine = storage(() => source?.()?.addMachine === true, MACHINE_NOTICE_INPUTS);
    const managePluginId = storage(() => source?.()?.managePluginId ?? null, MACHINE_NOTICE_INPUTS);
    const suppressedAdd = addMachine && surroundingAddRecovery;
    const action = React.useMemo(() => suppressedAdd ? null : addMachine
        ? { label: t('settings.addMachine'), onPress: () => { runGuardedNavigation(() => router.push(MACHINES_ADD_ROUTE as never)); } }
        : managePluginId
            ? { label: t('settingsPlugins.managePlugin'), onPress: () => { runGuardedNavigation(() => router.push(buildPluginDetailRoute('settings', managePluginId) as never)); } }
            : undefined, [suppressedAdd, addMachine, managePluginId, router]);
    // A failure state that claims the sentence says it in its own place, and the body is then that one line.
    const content = React.useMemo(() => (sentence === null ? null : { sentence, ...(action !== undefined ? { action } : {}) }), [sentence, action]);
    const { notice: surfaceNotice, claimed } = useClaimableSurfaceNotice(content);
    return (
        <WidgetFrameBodyNoticeContext.Provider value={lend}>
            {sentence === null || claimed ? null : (
                <SurfaceStateCard
                    testID={`${props.testID}-machine-notice`}
                    kind="unavailable"
                    size="line"
                    title={sentence}
                    action={suppressedAdd ? undefined : action ?? { label: t('common.retry'), onPress: retry }}
                    accessibilitySemantics="status"
                />
            )}
            <PluginUiSurfaceNoticeContext.Provider value={surfaceNotice}>
                <View testID={`${props.testID}-body`} style={bodyStyle}>
                    <React.Fragment key={attempt}>{props.children}</React.Fragment>
                </View>
            </PluginUiSurfaceNoticeContext.Provider>
        </WidgetFrameBodyNoticeContext.Provider>
    );
}

// The body lends a live controller query whose inputs can be held in refs.
const MACHINE_NOTICE_INPUTS = {
    machines: true, machineListByServerId: true, machineListStatusByServerId: true,
    settings: true, profileScope: true,
} satisfies StorageSubscriptionScope;
const bodyStyle = { flexGrow: 1, minWidth: 0 } as const;
