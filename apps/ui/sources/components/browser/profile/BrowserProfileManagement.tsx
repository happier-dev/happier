import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import type { BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';
import type { BrowserProfileV1 } from '@happier-dev/protocol/browser/profile/v1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

export type BrowserProfileManagementModel = Readonly<{
    source: Readonly<{
        scope: ServerAccountScope;
        machineId: string;
        selection?: Readonly<{
            command: Omit<Extract<BrowserCommandV1, { kind: 'openView' }>, 'profileId' | 'commandId'>;
            onSelected(profile: BrowserProfileV1, events: readonly BrowserEventV1[]): void;
        }>;
    }>;
}>;

const stylesheet = StyleSheet.create(theme => ({
    root: { width: '100%', gap: theme.space.s6, flex: 1, minHeight: 0 },
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s6 },
    list: { width: '100%', flex: 1, minHeight: 0 },
}));
const profileKey = (profile: BrowserProfileV1) => profile.profileId;

/** Mounted only in the open privacy panel; the Machine's existing store owns saved profiles. */
export function BrowserProfileManagement(props: Readonly<{ model: BrowserProfileManagementModel; testID: string }>) {
    const { source } = props.model;
    const { executeValue, ready } = useMountedActionExecution(source.scope);
    const operation = React.useMemo(() => ({ externalActionTarget: { kind: 'machine' as const, machineId: source.machineId } }), [source.machineId]);
    const [profiles, setProfiles] = React.useState<readonly BrowserProfileV1[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const refresh = useEventCallback(async () => {
        try {
            const result = PUBLIC_ACTION_OUTPUT_SCHEMAS['browser.profile.list'].parse(
                await executeValue('browser.profile.list', { machineId: source.machineId }, operation));
            if (result.status !== 'ready') throw new Error(result.code);
            setProfiles(result.profiles);
            setFailed(false);
        } catch { setFailed(true); }
    });
    React.useEffect(() => { if (ready) void refresh(); }, [ready, refresh, source.machineId]);

    const create = useEventCallback(async () => {
        const displayName = await Modal.prompt(t('browserShell.profile.management.createProfile'), t('common.name'));
        if (!displayName?.trim()) return;
        setBusy(true);
        try {
            const result = PUBLIC_ACTION_OUTPUT_SCHEMAS['browser.profile.create'].parse(await executeValue('browser.profile.create', {
                machineId: source.machineId, profileId: randomUUID(), displayName: displayName.trim(),
            }, operation));
            if (result.status !== 'created') throw new Error(result.code);
            setProfiles(previous => [...previous, result.profile]);
        } catch { Modal.alert(t('common.error'), t('errors.operationFailed')); }
        finally { setBusy(false); }
    });
    const select = useEventCallback(async (profile: BrowserProfileV1) => {
        const selection = source.selection;
        if (!selection || !await Modal.confirm(t('browserShell.profile.management.selectProfile'),
            t('browserShell.profile.management.selectWarning'))) return;
        setBusy(true);
        try {
            const result = PUBLIC_ACTION_OUTPUT_SCHEMAS['browser.profile.select'].parse(await executeValue('browser.profile.select', {
                ...selection.command, commandId: randomUUID(), machineId: source.machineId, profileId: profile.profileId,
            }, operation));
            if (result.status !== 'dispatched') throw new Error(result.status);
            selection.onSelected(profile, result.events);
        } catch { Modal.alert(t('common.error'), t('errors.operationFailed')); }
        finally { setBusy(false); }
    });
    const remove = useEventCallback(async (profile: BrowserProfileV1) => {
        if (!await Modal.confirm(t('common.delete'), t('browserShell.profile.management.deleteWarning'),
            { confirmText: t('common.delete'), destructive: true })) return;
        setBusy(true);
        try {
            const result = PUBLIC_ACTION_OUTPUT_SCHEMAS['browser.profile.delete'].parse(await executeValue('browser.profile.delete', {
                machineId: source.machineId, profileId: profile.profileId,
            }, operation));
            if (result.status !== 'deleted') throw new Error(result.code);
            setProfiles(previous => previous.filter(candidate => candidate.profileId !== result.profileId));
        } catch { Modal.alert(t('common.error'), t('errors.operationFailed')); }
        finally { setBusy(false); }
    });
    const renderProfile = React.useCallback(({ item: profile }: Readonly<{ item: BrowserProfileV1 }>) => (
        <View style={stylesheet.row}>
            <RoundButton size="small" display="secondary" title={profile.displayName ?? t('browserShell.profile.management.selectProfile')}
                testID={`${props.testID}-profile-select-${profile.profileId}`} disabled={busy || !ready || !source.selection}
                onPress={() => { void select(profile); }} />
            <RoundButton size="small" display="secondary" title={t('common.delete')}
                testID={`${props.testID}-profile-delete-${profile.profileId}`} disabled={busy || !ready}
                onPress={() => { void remove(profile); }} />
        </View>
    ), [busy, props.testID, ready, remove, select, source.selection]);
    return <View testID={`${props.testID}-management`} style={stylesheet.root}>
        <RoundButton size="small" display="secondary" title={t('browserShell.profile.management.createProfile')}
            testID={`${props.testID}-profile-create`} disabled={busy || !ready} onPress={() => { void create(); }} />
        {failed ? <View style={stylesheet.row}>
            <Text>{t('errors.operationFailed')}</Text>
            <RoundButton size="small" display="secondary" title={t('common.retry')}
                testID={`${props.testID}-profiles-retry`} disabled={!ready} onPress={() => { void refresh(); }} />
        </View> : null}
        <VirtualizedList data={profiles} keyExtractor={profileKey} renderItem={renderProfile}
            style={stylesheet.list} extraData={renderProfile} recycleItems={false} />
    </View>;
}
