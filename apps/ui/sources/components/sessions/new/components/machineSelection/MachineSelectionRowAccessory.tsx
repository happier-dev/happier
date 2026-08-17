import * as React from 'react';
import { Platform, Pressable, View, type GestureResponderEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import { resolveMachinePickerPresence } from '../resolveMachinePickerPresence';
import { Icon } from '@/components/ui/icons/Icon';

type AccessoryPressEvent = Partial<GestureResponderEvent> & {
    nativeEvent?: GestureResponderEvent['nativeEvent'] & {
        stopImmediatePropagation?: () => void;
    };
};

export type MachineSelectionRowAccessoryProps = Readonly<{
    machine: Machine;
    serverId?: string | null;
    readinessTestID?: string;
    showCliGlyphs: boolean;
    autoDetectCliGlyphs: boolean;
    showFavoriteToggle: boolean;
    isFavorite: boolean;
    onToggleFavorite?: (machine: Machine) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    readiness: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    readinessText: {
        color: theme.colors.text.secondary,
    },
    favoriteButton: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
    },
}));

export function MachineSelectionRowAccessory(props: MachineSelectionRowAccessoryProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const presence = resolveMachinePickerPresence(props.machine);
    const readinessState = presence.selectable ? 'ready' : presence.status;
    const readinessColor = presence.selectable
        ? theme.colors.status.connected
        : theme.colors.status.disconnected;
    const selectedColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;

    const handleToggleFavorite = React.useCallback((event?: AccessoryPressEvent) => {
        event?.stopPropagation?.();
        event?.nativeEvent?.stopImmediatePropagation?.();
        props.onToggleFavorite?.(props.machine);
    }, [props]);

    return (
        <View style={styles.container}>
            <View
                testID={props.readinessTestID}
                {...(readinessState
                    ? {
                        'data-state': readinessState,
                        ...(Platform.OS === 'web' ? { dataSet: { state: readinessState } } : {}),
                    }
                    : {})}
                style={styles.readiness}
            >
                <View style={[styles.dot, { backgroundColor: readinessColor }]} />
                <Text style={styles.readinessText}>
                    {presence.selectable ? t('status.online') : t('status.offline')}
                </Text>
            </View>
            {props.showCliGlyphs ? (
                <MachineCliGlyphs
                    machineId={props.machine.id}
                    serverId={props.serverId}
                    isOnline={isMachineOnline(props.machine)}
                    autoDetect={props.autoDetectCliGlyphs}
                />
            ) : null}
            {props.showFavoriteToggle && props.onToggleFavorite ? (
                <Pressable
                    hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                    onPress={handleToggleFavorite}
                    style={styles.favoriteButton}
                    accessibilityRole="button"
                    accessibilityLabel={props.isFavorite
                        ? t('newSession.pathPicker.favoriteRemove')
                        : t('newSession.pathPicker.favoriteAdd')}
                >
                    <Icon
                        name="star"
                        size={20}
                        color={props.isFavorite ? selectedColor : theme.colors.text.secondary}
                        weight={props.isFavorite ? 'fill' : 'regular'}
                    />
                </Pressable>
            ) : null}
        </View>
    );
}
