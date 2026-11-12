import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import type { BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';
import type { BrowserProfileV1 } from '@happier-dev/protocol/browser/profile/v1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

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
    root: { width: '100%', minHeight: 0, flexShrink: 1, marginTop: theme.space.s8 },
    list: { width: '100%', flexShrink: 1, minHeight: 0 },
}));
const profileKey = (profile: BrowserProfileV1) => profile.profileId;
/** A one- or two-line profile row, for the list's first layout before its rows are measured. */
const PROFILE_ROW_ESTIMATE_PX = 52;

function profileFailureMessage(error: unknown): string {
    const fallback = error instanceof HappyError && error.code
        ? `${t('common.requestFailed')} (${error.code})` : t('common.requestFailed');
    return resolveActionExecutionErrorMessage(error, fallback);
}

/** Mounted only in the open privacy panel; the Machine's existing store owns saved profiles. */
export function BrowserProfileManagement(props: Readonly<{
    model: BrowserProfileManagementModel;
    testID: string;
    /** The profile this browser uses now, read as "In use" on its row. */
    currentProfileId?: string | null;
}>) {
    const { source } = props.model;
    const { executeValue, ready } = useMountedActionExecution(source.scope);
    const operation = React.useMemo(() => ({ externalActionTarget: { kind: 'machine' as const, machineId: source.machineId },
        retainEffectResult: true as const }), [source.machineId]);
    const [profiles, setProfiles] = React.useState<readonly BrowserProfileV1[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [failed, setFailed] = React.useState<string | null>(null);
    const refresh = useEventCallback(async () => {
        try {
            const result = PUBLIC_ACTION_OUTPUT_SCHEMAS['browser.profile.list'].parse(
                await executeValue('browser.profile.list', { machineId: source.machineId }, operation));
            if (result.status !== 'ready') throw new HappyError(result.code, false, { code: result.code });
            setProfiles(result.profiles);
            setFailed(null);
        } catch (error) { setFailed(profileFailureMessage(error)); }
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
            if (result.status !== 'created') throw new HappyError(result.code, false, { code: result.code });
            setProfiles(previous => [...previous, result.profile]);
        } catch (error) { Modal.alert(t('common.error'), profileFailureMessage(error)); }
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
            if (result.status === 'unavailable') throw new HappyError(result.code, false, { code: result.code });
            if (result.status === 'failed') throw new HappyError(result.error.message, false, { code: result.error.code });
            selection.onSelected(profile, result.events);
        } catch (error) { Modal.alert(t('common.error'), profileFailureMessage(error)); }
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
            if (result.status !== 'deleted') throw new HappyError(result.code, false, { code: result.code });
            setProfiles(previous => previous.filter(candidate => candidate.profileId !== result.profileId));
        } catch (error) { Modal.alert(t('common.error'), profileFailureMessage(error)); }
        finally { setBusy(false); }
    });
    const rowData = React.useMemo(() => ({ busy, ready, canSelect: Boolean(source.selection), currentProfileId: props.currentProfileId }),
        [busy, ready, source.selection, props.currentProfileId]);
    const unnamed = t('browserShell.profile.management.unnamed');
    const nameCounts = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const profile of profiles) {
            const name = (profile.displayName ?? unnamed).toLocaleLowerCase();
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return counts;
    }, [profiles, unnamed]);
    const renderProfile = React.useCallback(({ item: profile }: Readonly<{ item: BrowserProfileV1 }>) => (
        <ProfileRow profile={profile} testID={props.testID} state={rowData} onSelect={select} onRemove={remove}
            identityHint={(nameCounts.get((profile.displayName ?? unnamed).toLocaleLowerCase()) ?? 0) > 1 ? profile.profileId : undefined} />
    ), [nameCounts, props.testID, remove, rowData, select, unnamed]);
    // The list asks for the room its rows need and shrinks to what the panel has left: no empty tail, and it
    // scrolls once the panel is full.
    const [contentHeight, setContentHeight] = React.useState<number | null>(null);
    return <View testID={`${props.testID}-management`} style={stylesheet.root}>
        <ItemGroup title={t('browserShell.profile.management.savedProfiles')}>
            {failed ? <Item testID={`${props.testID}-profiles-failed`} title={failed} titleLines={2} mode="info" showChevron={false}
                rightElement={<RoundButton size="small" display="secondary" title={t('common.retry')}
                    testID={`${props.testID}-profiles-retry`} disabled={!ready} onPress={() => { void refresh(); }} />} /> : null}
            <VirtualizedList data={profiles} keyExtractor={profileKey} renderItem={renderProfile}
                // Legend lays rows out inside a measured viewport: start from the rows' estimate, then take their real height.
                style={[stylesheet.list, { height: contentHeight || profiles.length * PROFILE_ROW_ESTIMATE_PX,
                    // This content-sized group has no free flex space; keep the rows' measured basis.
                    flexGrow: 0, flexBasis: 'auto' }]}
                estimatedItemSize={PROFILE_ROW_ESTIMATE_PX}
                onContentSizeChange={(_width, height) => setContentHeight(height)}
                extraData={renderProfile} recycleItems={false} />
            <ItemAddRow testID={`${props.testID}-profile-create`} title={t('browserShell.profile.management.createProfile')}
                disabled={busy || !ready} onPress={() => { void create(); }} />
        </ItemGroup>
    </View>;
}

type ProfileRowState = Readonly<{ busy: boolean; ready: boolean; canSelect: boolean; currentProfileId: string | null | undefined }>;

/** One saved profile: its name and whether this browser uses it; pressing it switches, Delete waits behind ⋯. */
const ProfileRow = React.memo(function ProfileRow(props: Readonly<{
    profile: BrowserProfileV1;
    identityHint?: string;
    testID: string;
    state: ProfileRowState;
    onSelect(profile: BrowserProfileV1): Promise<void>;
    onRemove(profile: BrowserProfileV1): Promise<void>;
}>) {
    const { profile, state, onSelect, onRemove } = props;
    const title = profile.displayName ?? t('browserShell.profile.management.unnamed');
    const name = props.identityHint ? `${title} · ${props.identityHint}` : title;
    const current = state.currentProfileId === profile.profileId;
    const unusable = profile.lifecycleState === 'unusable';
    const actions = React.useMemo((): ItemAction[] => [{
        id: `${props.testID}-profile-delete-${profile.profileId}`,
        title: t('browserShell.profile.management.deleteProfile'),
        accessibilityLabel: t('browserShell.profile.management.deleteNamed', { name }),
        icon: 'trash',
        destructive: true,
        disabled: state.busy || !state.ready,
        onPress: () => { void onRemove(profile); },
    }], [name, onRemove, profile, props.testID, state.busy, state.ready]);
    return (
        <Item
            testID={`${props.testID}-profile-select-${profile.profileId}`}
            title={title}
            titleQualifier={props.identityHint}
            subtitle={current ? t('browserShell.profile.management.inUse')
                : unusable ? t('browserShell.profile.management.profileUnavailable')
                    : !state.canSelect ? t('browserShell.profile.management.openBrowserToSwitch') : undefined}
            subtitleLines={2}
            accessibilityLabel={t('browserShell.profile.management.useProfile', { name })}
            selected={current}
            showChevron={false}
            disabled={state.busy || !state.ready || !state.canSelect || current || unusable}
            onPress={() => { void onSelect(profile); }}
            rightElement={<ItemRowActions title={name} actions={actions} overflowOnly
                overflowTriggerTestID={`${props.testID}-profile-more-${profile.profileId}`}
                overflowTriggerAccessibilityLabel={t('browserShell.profile.management.moreFor', { name })} />}
            rightElementOutsidePressable
        />
    );
});
