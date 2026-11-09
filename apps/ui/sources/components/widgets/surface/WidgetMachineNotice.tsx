import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { PluginUiSurfaceNoticeContext } from '@happier-dev/plugin-ui/advanced';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
export function WidgetMachineNoticeBoundary(props: Readonly<{ testID: string; children: React.ReactNode }>): React.ReactElement {
    const [source, setSource] = React.useState<WidgetFrameBodyNoticeSource | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const [claimants, setClaimants] = React.useState<ReadonlySet<string>>(EMPTY_CLAIMANTS);
    const lend = React.useCallback((next: WidgetFrameBodyNoticeSource | null) => setSource(() => next), []);
    const retry = React.useCallback(() => {
        setSource(null);
        setAttempt((current) => current + 1);
    }, []);
    const claim = React.useCallback((id: string) => {
        setClaimants((current) => (current.has(id) ? current : new Set(current).add(id)));
        return () => setClaimants((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
        });
    }, []);
    const router = useRouter();
    // Primitive selections keep each snapshot stable by value while the stores change.
    const sentence = storage(() => source?.()?.sentence ?? null, MACHINE_NOTICE_INPUTS);
    const addMachine = storage(() => source?.()?.addMachine === true, MACHINE_NOTICE_INPUTS);
    const managePluginId = storage(() => source?.()?.managePluginId ?? null, MACHINE_NOTICE_INPUTS);
    const action = React.useMemo(() => addMachine
        ? { label: t('settings.addMachine'), onPress: () => { runGuardedNavigation(() => router.push(MACHINES_ADD_ROUTE as never)); } }
        : managePluginId
            ? { label: t('settingsPlugins.managePlugin'), onPress: () => { runGuardedNavigation(() => router.push(buildPluginDetailRoute('settings', managePluginId) as never)); } }
            : undefined, [addMachine, managePluginId, router]);
    const surfaceNotice = React.useMemo(
        () => (sentence === null ? null : { sentence, claim, ...(action ? { action } : {}) }),
        [sentence, claim, action],
    );
    return (
        <WidgetFrameBodyNoticeContext.Provider value={lend}>
            {sentence === null || claimants.size > 0 ? null : (
                <SurfaceStateCard
                    testID={`${props.testID}-machine-notice`}
                    kind="warning"
                    size="line"
                    title={sentence}
                    action={action ?? { label: t('common.retry'), onPress: retry }}
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

const EMPTY_CLAIMANTS: ReadonlySet<string> = new Set();
// The body lends a live controller query whose inputs can be held in refs.
const MACHINE_NOTICE_INPUTS = {
    machines: true, machineListByServerId: true, machineListStatusByServerId: true,
    settings: true, profileScope: true,
} satisfies StorageSubscriptionScope;
const bodyStyle = { flexGrow: 1, minWidth: 0 } as const;
