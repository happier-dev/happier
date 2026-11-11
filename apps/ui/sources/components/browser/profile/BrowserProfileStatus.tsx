import * as React from 'react';
import { View } from 'react-native';

import { StyleSheet } from 'react-native-unistyles';
import type { BrowserPermissionStateV1 } from '@happier-dev/protocol/browser/permissions/v1';
import type {
    BrowserProfileStorageModeV1,
    BrowserProfileV1} from '@happier-dev/protocol/browser/profile/v1';
import type {
    BrowserStoragePartitionV1,
    BrowserStoragePersistenceV1,
} from '@happier-dev/protocol/browser/storage/v1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { BrowserProfileManagement, type BrowserProfileManagementModel } from './BrowserProfileManagement';
export type { BrowserProfileManagementModel } from './BrowserProfileManagement';

const stylesheet = StyleSheet.create(() => ({
    root: {
        flexShrink: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

export type BrowserProfileStatusModel = Readonly<{
    profile: BrowserProfileV1 | null;
    storagePartition?: BrowserStoragePartitionV1 | null;
    activePermissionGrantCount?: number;
    permissionState?: BrowserPermissionStateV1 | null;
    management?: BrowserProfileManagementModel;
}>;

/** A profile with no name of its own is named by what kind of profile it is. */
function profileName(mode: BrowserProfileStorageModeV1 | null): string {
    switch (mode) {
        case 'ephemeral': return t('browserShell.profile.name.ephemeral');
        case 'session': return t('browserShell.profile.name.session');
        case 'user': return t('browserShell.profile.name.user');
        case 'plugin': return t('browserShell.profile.name.plugin');
        case null: return t('browserShell.profile.name.unavailable');
    }
}

function storageLabel(persistence: BrowserStoragePersistenceV1 | null): string {
    switch (persistence) {
        case 'ephemeral': return t('browserShell.profile.storage.ephemeral');
        case 'session': return t('browserShell.profile.storage.session');
        case 'persistent': return t('browserShell.profile.storage.persistent');
        case 'plugin': return t('browserShell.profile.storage.plugin');
        case null: return t('browserShell.profile.storage.unavailable');
    }
}

function permissionLabel(input: Readonly<{
    permissionState?: BrowserPermissionStateV1 | null;
    activePermissionGrantCount?: number;
}>): string {
    if (input.permissionState === 'denied') return t('browserShell.profile.permissions.denied');
    if (input.permissionState === 'prompt') return t('browserShell.profile.permissions.prompt');
    const count = input.activePermissionGrantCount ?? 0;
    return count > 0 ? t('browserShell.profile.permissions.active', { count }) : t('browserShell.profile.permissions.none');
}

/**
 * The privacy panel's body: which profile this browser uses and what it keeps, in one row (identity
 * first), then the Machine's saved profiles when a managed browser can switch between them.
 */
export function BrowserProfileStatus(props: Readonly<{
    model: BrowserProfileStatusModel;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-profile-status';
    const profile = props.model.profile;
    const mode = profile?.storageMode ?? null;
    const storage = props.model.storagePartition?.persistence ?? null;
    const management = props.model.management;

    return (
        <View testID={testID} style={stylesheet.root} accessibilityLabel={t('browserShell.profile.title')}>
            <ItemGroup>
                <Item
                    testID={`${testID}-identity`}
                    title={profile?.displayName ?? profileName(mode)}
                    subtitle={`${storageLabel(storage)} · ${permissionLabel(props.model)}`}
                    subtitleLines={2}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
            {management ? (
                <BrowserProfileManagement
                    key={JSON.stringify([management.source.scope.serverId, management.source.scope.accountId, management.source.machineId])}
                    testID={testID}
                    model={management}
                    currentProfileId={profile?.profileId ?? null}
                />
            ) : null}
        </View>
    );
}
