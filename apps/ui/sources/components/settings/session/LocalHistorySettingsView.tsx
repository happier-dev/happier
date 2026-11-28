import * as React from 'react';
import type { DirectSessionRetentionRequest, DirectSessionRetentionState } from '@happier-dev/protocol';
import { useRouter } from 'expo-router';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useShallow } from 'zustand/react/shallow';

import { listLocalHistoryProviders } from '@/agents/registry/registryCore';
import { showLocalHistoryKeepOrLetGoSheet } from '@/components/sessions/keepOrLetGo/KeepOrLetGoSheet';
import { useLocalHistoryKeepSource } from '@/components/sessions/keepOrLetGo/localHistoryKeepSource';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { storage } from '@/sync/domains/state/storage';
import { machineDirectSessionRetention, machineLocalHistory } from '@/sync/ops/machineDirectSessions';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { t } from '@/text';
import { isMachineOnline, readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

type RequestState = 'loading' | 'unavailable' | 'error' | DirectSessionRetentionState;
type LocalHistoryProvider = ReturnType<typeof listLocalHistoryProviders>[number];

function LocalHistoryRow({ machineId, serverId, provider }: Readonly<{
    machineId: string;
    serverId: string;
    provider: LocalHistoryProvider;
}>) {
    const router = useRouter();
    const focused = useIsFocused();
    const title = t(provider.displayNameKey);
    const [state, setState] = React.useState<RequestState>('loading');
    const [revision, retry] = React.useReducer((value: number) => value + 1, 0);
    const [saving, setSaving] = React.useState(false);
    const saveInFlight = React.useRef(false);
    const due = useLocalHistoryKeepSource({ enabled: focused && typeof state !== 'string' && !state.never, machineId, providerId: provider.localHistory.providerId });
    const request = React.useCallback(async (operation: DirectSessionRetentionRequest['operation'], expectedCurrentDays: number | null = null): Promise<RequestState> => {
        try {
            const { providerId, source } = provider.localHistory;
            const base = { providerId, source };
            const response = await machineLocalHistory(machineId, operation === 'read'
                ? { ...base, operation: 'status.get' }
                : { ...base, operation: 'retention.set', days: 'never', expectedCurrentDays }, { serverId });
            if (response.ok && response.retention) return response.retention;
            if (!response.ok && response.errorCode === 'provider_unavailable') {
                const legacy = await machineDirectSessionRetention(machineId,
                    operation === 'read' ? { ...base, operation } : { ...base, operation, days: 'never' }, { serverId });
                return legacy.ok ? legacy.retention : legacy.errorCode === 'provider_unavailable' ? 'unavailable' : 'error';
            }
            return 'error';
        } catch {
            return 'error';
        }
    }, [machineId, provider, serverId]);

    useFocusEffect(React.useCallback(() => {
        let active = true;
        setState('loading');
        void request('read').then(result => { if (active) setState(result); });
        return () => { active = false; };
    }, [request, revision]));

    if (state === 'loading') return <Item title={title} subtitle={t('common.loading')} />;
    if (state === 'unavailable') return <Item title={title} subtitle={t('settingsSession.localHistory.unavailable')} />;
    if (state === 'error') return <Item title={title} subtitle={t('settingsProviders.sessionRetention.error')}
        detail={t('common.retry')} onPress={() => retry()} />;
    if (state.blockedReason === 'accountSettingsUnavailable') return <Item title={title}
        subtitle={t('settingsProviders.sessionRetention.error')} detail={t('common.retry')} onPress={() => retry()} />;

    const days = state.currentDays ?? state.defaultDays;
    const period = state.never ? t('settingsSession.localHistory.never')
        : state.currentDays !== null || state.writable ? t('settingsSession.localHistory.period', { days })
        : undefined;
    const blocked = state.blockedReason === 'managed' ? t('settingsProviders.sessionRetention.managed')
        : state.blockedReason === 'unreadable' ? t('settingsProviders.sessionRetention.invalidSettings')
        : state.blockedReason === 'accountPolicy' ? t('settingsSession.localHistory.accountPolicy')
        : undefined;
    return <>
        <Item title={title} detail={period} subtitle={blocked}
            onPress={state.blockedReason === 'accountPolicy' ? () => router.push(provider.localHistory.accountPolicyRoute) : undefined} />
        {due.items.length > 0 ? <Item
            title={t('keepOrLetGo.localLeaving', { count: due.items.length })}
            detail={t('keepOrLetGo.review')}
            onPress={() => showLocalHistoryKeepOrLetGoSheet(due.items, due.remove)}
        /> : due.failed ? <Item title={t('keepOrLetGo.loadFailed')} detail={t('common.retry')} onPress={due.retry} /> : null}
        {state.writable && !state.never ? <Item
            testID={`local-history-${provider.id}-never`}
            title={t('settingsSession.localHistory.never')}
            subtitle={t('settingsSession.localHistory.neverHint')}
            disabled={saving}
            onPress={async () => {
                if (saveInFlight.current) return;
                saveInFlight.current = true;
                setSaving(true);
                try {
                    setState(await request('write', state.currentDays));
                } finally {
                    saveInFlight.current = false;
                    setSaving(false);
                }
            }}
        /> : null}
    </>;
}

export default function LocalHistorySettingsView() {
    const { serverId } = useActiveServerSnapshot();
    const machines = storage(useShallow(resolveVisibleMachinesForActiveServerFromState));
    const [selection, setSelection] = React.useState<Readonly<{ serverId: string; machineId: string }> | null>(null);
    const selected = selection?.serverId === serverId
        ? machines.find(machine => machine.id === selection.machineId) ?? null
        : machines.length === 1 ? machines[0] ?? null : null;
    const nowMs = useSessionListRuntimeNowMs(Boolean(selected));
    useSessionListRuntimeWake(selected ? readMachineStatusNextRefreshAtMs(selected, nowMs) : null, Boolean(selected));
    const online = selected ? isMachineOnline(selected, nowMs) : false;
    return <ItemList>
        <MachineSelector
            machines={machines}
            selectedMachine={selected}
            onSelect={machine => setSelection({ serverId, machineId: machine.id })}
            showFavorites={false}
            showRecent={false}
            showCliGlyphs={false}
            presentation="dropdown"
            serverId={serverId}
        />
        {selected ? <ItemGroup>
            {listLocalHistoryProviders().map(provider => online
                ? <LocalHistoryRow key={JSON.stringify([serverId, selected.id, provider.id])}
                    machineId={selected.id} serverId={serverId} provider={provider} />
                : <Item key={provider.id} title={t(provider.displayNameKey)} subtitle={t('settingsProviders.sessionRetention.offline')} />)}
        </ItemGroup> : null}
    </ItemList>;
}
