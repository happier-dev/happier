import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ComputerGrantStatusV1 } from '@happier-dev/protocol/computer/v1';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX } from '@/components/ui/lists/itemGroupSpacing';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SystemPermissionRow, type SystemPermissionRowState } from '@/components/systemPermissions/SystemPermissionRow';
import { t } from '@/text';
import { useHostActivelyFocusedEffect } from '@/utils/runtime/useHostActivelyViewed';
import { resolveComputerRecovery } from '@/sync/domains/computer/targets';

export { needsComputerPermission } from '@/sync/domains/computer/targets';

/** The daemon-side "open the privacy pane" request (W7 `computer.permissions.openSettings`). */
export type ComputerOpenSettingsState = 'idle' | 'opening' | 'opened' | 'failed';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
    },
    grants: {
        alignSelf: 'stretch',
        width: '100%',
        maxWidth: 380,
        marginHorizontal: 'auto',
    },
    // The rows share the card's one measure (copy, live line, actions): the sheet cancels the group's own inset.
    grantsSheet: {
        marginHorizontal: -(Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX) ?? 0),
    },
}));

/** The machine's grant answer as the shared grant row reads it; this card's one action sits below the rows. */
const GRANT_ROW_STATE = { granted: 'granted', denied: 'missing', unknown: 'unknown' } as const satisfies Record<ComputerGrantStatusV1['capture'], SystemPermissionRowState>;

/**
 * The OS permission the machine needs first (lab `b-mac` P): which one is missing, said as what it
 * unlocks, that it is granted on that machine and not on this device, and **Open privacy settings on
 * {machine}**, which asks that machine's daemon to open the pane there (so it works from a phone
 * too). Happier never changes the permission itself; Check again re-reads the machine. The picker
 * and the viewer's picture draw this one card.
 */
export function ComputerPermissionCard(props: Readonly<{
    machineName: string;
    grants: ComputerGrantStatusV1;
    openSettings: ComputerOpenSettingsState;
    onOpenSettings: (permission: 'capture' | 'input') => void;
    onCheckAgain: () => void;
    testID?: string;
}>): React.ReactElement {
    const permission = resolveComputerRecovery({ kind: 'ready', targets: [], grants: props.grants }, 'use')?.permission ?? 'capture';
    const machine = props.machineName;
    const unknown = props.grants[permission] === 'unknown';
    const testID = props.testID ?? 'computer-permission';
    // The OS offers no grant-change event, so the natural boundary is the person's return: once the
    // pane was opened on the machine, coming back to Happier re-reads its grants exactly once. A second
    // return re-reads only after the pane is opened again; Check again stays for everything else.
    const wasFocused = React.useRef(true);
    const awaitingReturn = React.useRef(false);
    React.useEffect(() => {
        awaitingReturn.current = props.openSettings === 'opened';
    }, [props.openSettings]);
    const onCheckAgain = props.onCheckAgain;
    useHostActivelyFocusedEffect((focused) => {
        const returned = focused && !wasFocused.current;
        wasFocused.current = focused;
        if (!returned || !awaitingReturn.current) return;
        awaitingReturn.current = false;
        onCheckAgain();
    }, [onCheckAgain]);
    return (
        <View style={stylesheet.root} testID={testID} accessibilityLiveRegion="polite">
            <SurfaceStateCard
                kind="denied"
                iconName="shield"
                title={unknown
                    ? t('computerUse.permission.unknownTitle', { machine })
                    : t('computerUse.permission.title', { machine })}
                // One message: the rows below already say which permission is missing and what it unlocks.
                reason={t('computerUse.permission.body', { machine })}
                // The present, with the copy: waiting on the person at the machine, or why the pane didn't open.
                // Waiting on a person, not on work in flight: the line carries no working mark.
                live={props.openSettings === 'opened'
                    ? { text: t('computerUse.permission.opened', { machine }) }
                    : props.openSettings === 'failed' ? { text: t('computerUse.permission.openFailed') } : undefined}
                // Opening the pane is the way in, not a retry: the card's one filled primary (lab `computer` OG).
                action={{
                    invitation: true,
                    label: t('computerUse.permission.openPrivacy', { machine }),
                    onPress: () => props.onOpenSettings(permission),
                    busy: props.openSettings === 'opening',
                    testID: `${testID}-open-settings`,
                }}
                secondaryAction={{
                    label: t('computerUse.permission.checkAgain'),
                    onPress: props.onCheckAgain,
                    testID: `${testID}-check-again`,
                }}
                // The two permissions with their real state on the machine, so the person sees which
                // one is missing and what each unlocks (lab `computer` OG).
                body={(
                    <View style={stylesheet.grants}>
                        <ItemGroup testID={`${testID}-grants`} containerStyle={stylesheet.grantsSheet}>
                            <SystemPermissionRow testID={`${testID}-grant-capture`} title={t('computerUse.permission.capture')}
                                purpose={t('computerUse.permission.captureFor')} state={GRANT_ROW_STATE[props.grants.capture]} />
                            <SystemPermissionRow testID={`${testID}-grant-input`} title={t('computerUse.permission.input')}
                                purpose={t('computerUse.permission.inputFor')} state={GRANT_ROW_STATE[props.grants.input]} />
                        </ItemGroup>
                    </View>
                )}
            />
        </View>
    );
}
