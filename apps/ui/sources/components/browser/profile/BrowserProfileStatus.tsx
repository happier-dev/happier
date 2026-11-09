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

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { BROWSER_CHROME_WIDTH } from '../browserChromeDensity';
import { BrowserProfileManagement, type BrowserProfileManagementModel } from './BrowserProfileManagement';
export type { BrowserProfileManagementModel } from './BrowserProfileManagement';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'column',
        flexShrink: 1,
        gap: theme.space.s6,
        minHeight: 34,
        minWidth: 0,
        maxWidth: BROWSER_CHROME_WIDTH.panel,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: theme.space.s10,
    },
    management: {
        flex: 1,
        minHeight: 0,
    },
    segment: {
        minWidth: 0,
    },
    label: {
        color: theme.colors.text.secondary,
    },
    value: {
        color: theme.colors.text.primary,
    },
    facts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
    },
    separator: {
        color: theme.colors.text.disabled,
    },
}));

export type BrowserProfileStatusModel = Readonly<{
    profile: BrowserProfileV1 | null;
    storagePartition?: BrowserStoragePartitionV1 | null;
    activePermissionGrantCount?: number;
    permissionState?: BrowserPermissionStateV1 | null;
    management?: BrowserProfileManagementModel;
}>;

function modeLabel(mode: BrowserProfileStorageModeV1 | null): string {
    if (!mode) return t('browserShell.profile.unavailable');
    switch (mode) {
        case 'ephemeral':
            return t('browserShell.profile.mode.ephemeral');
        case 'session':
            return t('browserShell.profile.mode.session');
        case 'user':
            return t('browserShell.profile.mode.user');
        case 'plugin':
            return t('browserShell.profile.mode.plugin');
    }
}

function storageLabel(persistence: BrowserStoragePersistenceV1 | null): string {
    if (!persistence) return t('browserShell.profile.storage.unavailable');
    switch (persistence) {
        case 'ephemeral':
            return t('browserShell.profile.storage.ephemeral');
        case 'session':
            return t('browserShell.profile.storage.session');
        case 'persistent':
            return t('browserShell.profile.storage.persistent');
        case 'plugin':
            return t('browserShell.profile.storage.plugin');
    }
}

function permissionLabel(input: Readonly<{
    permissionState?: BrowserPermissionStateV1 | null;
    activePermissionGrantCount?: number;
}>): string {
    if (input.permissionState === 'denied') {
        return t('browserShell.profile.permissions.denied');
    }
    if (input.permissionState === 'prompt') {
        return t('browserShell.profile.permissions.prompt');
    }
    const count = input.activePermissionGrantCount ?? 0;
    if (count > 0) {
        return t('browserShell.profile.permissions.active', { count });
    }
    return t('browserShell.profile.permissions.none');
}

function statusIdForPermission(input: BrowserProfileStatusModel): 'active' | 'denied' | 'none' | 'prompt' {
    if (input.permissionState === 'denied') return 'denied';
    if (input.permissionState === 'prompt') return 'prompt';
    return (input.activePermissionGrantCount ?? 0) > 0 ? 'active' : 'none';
}

function Segment(props: Readonly<{
    label: string;
    value: string;
    testID: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.segment}>
            <Text numberOfLines={1} style={stylesheet.label}>{props.label}</Text>
            <Text numberOfLines={1} style={stylesheet.value}>{props.value}</Text>
        </View>
    );
}

export function BrowserProfileStatus(props: Readonly<{
    model: BrowserProfileStatusModel;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-profile-status';
    const mode = props.model.profile?.storageMode ?? null;
    const storage = props.model.storagePartition?.persistence ?? null;
    const permissionStatusId = statusIdForPermission(props.model);

    return (
        <View testID={testID} style={[stylesheet.root, props.model.management ? stylesheet.management : null]} accessibilityLabel={t('browserShell.profile.title')}>
            <View style={stylesheet.facts}>
            <Segment
                testID={`${testID}-mode-${mode ?? 'unavailable'}`}
                label={t('browserShell.profile.modeLabel')}
                value={modeLabel(mode)}
            />
            <Text style={stylesheet.separator}>/</Text>
            <Segment
                testID={`${testID}-storage-${storage ?? 'unavailable'}`}
                label={t('browserShell.profile.storageLabel')}
                value={storageLabel(storage)}
            />
            <Text style={stylesheet.separator}>/</Text>
            <Segment
                testID={`${testID}-permissions-${permissionStatusId}`}
                label={t('browserShell.profile.permissionsLabel')}
                value={permissionLabel(props.model)}
            />
            </View>
            {props.model.management ? (
                <BrowserProfileManagement
                    key={JSON.stringify([props.model.management.source.scope.serverId, props.model.management.source.scope.accountId, props.model.management.source.machineId])}
                    testID={testID}
                    model={props.model.management}
                />
            ) : null}
        </View>
    );
}
