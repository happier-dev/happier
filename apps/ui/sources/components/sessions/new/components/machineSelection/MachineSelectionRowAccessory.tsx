import * as React from 'react';
import { MachineSummaryStrip } from '@/components/machines/summary/MachineSummaryStrip';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

import { resolveMachinePickerPresence } from '../resolveMachinePickerPresence';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { SelectionListOptionStateContext } from '@/components/ui/selectionList/SelectionListOptionStateContext';
import { Icon } from '@/components/ui/icons/Icon';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { useManagedProvisionerPresentation } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';

type AccessoryPressEvent = Readonly<{ stopPropagation?: () => void; nativeEvent?: unknown }>;

/**
 * The presence dot leading a machine row's status line ("● Online · …"). It carries the row's
 * readiness state (`data-state`: ready / offline / revoked / replaced) for tests and automation.
 */
export function MachinePresenceDot(props: Readonly<{
    machine: MachineDisplayRenderable;
    serverId?: string | null;
    readinessTestID?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    if (props.machine.presence === null) return null;
    const presence = resolveMachinePickerPresence(props.machine, undefined, binding?.isCurrent() ? binding.scope : null);
    const readinessState = presence.selectable ? 'ready' : presence.status;
    return (
        <View
            testID={props.readinessTestID}
            {...({
                'data-state': readinessState,
                ...(Platform.OS === 'web' ? { dataSet: { state: readinessState } } : {}),
            } as Record<string, unknown>)}
        >
            <StatusDot
                color={presence.selectable ? theme.colors.status.connected : theme.colors.status.disconnected}
            />
        </View>
    );
}

/** The provider's own mark for a machine Happier created, read like its page header reads it. */
function ManagedMachineRowMark(props: Readonly<{ machine: ManagedMachineV1; serverId: string; size: number }>): React.ReactElement {
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: props.machine.controller,
        provider: props.machine.launch.provider, schemaVersion: props.machine.launch.schemaVersion, purpose: 'mark' });
    return <>{presentation.markAt(props.size)}</>;
}

/**
 * A machine row's leading mark (lab m-pick): the provider's mark for a machine Happier created, else the
 * glyph for the machine's kind.
 */
export function MachineRowMark(props: Readonly<{
    machineId: string;
    /** The machine's published OS platform (`metadata.platform`); unknown keeps the desktop glyph. */
    platform?: string | null;
    serverId: string;
    managedMachine?: ManagedMachineV1;
    size: number;
    color?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const thisComputerMachineId = useThisComputerMachineId();
    if (props.managedMachine) {
        return <ManagedMachineRowMark machine={props.managedMachine} serverId={props.serverId} size={props.size} />;
    }
    return (
        <Icon
            name={resolveMachineKindGlyph({ isThisComputer: props.machineId === thisComputerMachineId, platform: props.platform })}
            size={props.size}
            color={props.color ?? theme.colors.text.secondary}
        />
    );
}

export type MachineSelectionRowAccessoryProps<TMachine extends MachineDisplayRenderable = Machine> = Readonly<{
    machine: TMachine;
    serverId?: string | null;
    showCliGlyphs: boolean;
    autoDetectCliGlyphs: boolean;
    showFavoriteToggle: boolean;
    isFavorite: boolean;
    onToggleFavorite?: (machine: TMachine) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    favoriteButton: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
    },
}));

/** The held summary's memory fact for one machine; renders nothing until a summary is held. */
const MachineMemoryFact = React.memo(function MachineMemoryFact(props: Readonly<{ machineId: string; serverId: string | null }>) {
    const availability = useMachineResourceSummary({ machineId: props.machineId, serverId: props.serverId });
    return <MachineSummaryStrip availability={availability} style="numbers" metrics={MEMORY_ONLY} layout="fact"
        testID={`machine-selection-memory:${props.machineId}`} />;
});

const MEMORY_ONLY = ['memory'] as const;

export function MachineSelectionRowAccessory<TMachine extends MachineDisplayRenderable = Machine>(
    props: MachineSelectionRowAccessoryProps<TMachine>,
): React.ReactElement | null {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const selectedColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;

    const handleToggleFavorite = React.useCallback((event?: AccessoryPressEvent) => {
        event?.stopPropagation?.();
        (event?.nativeEvent as { stopImmediatePropagation?: () => void } | undefined)?.stopImmediatePropagation?.();
        props.onToggleFavorite?.(props.machine);
    }, [props]);

    // On web the star stays out of the way until the person reaches the row (lab m-pick: no per-row star
    // noise); a favorite keeps its filled star. Touch has no pointer to reach a row with, so it keeps the star.
    const rowState = React.useContext(SelectionListOptionStateContext);
    const reached = Platform.OS !== 'web' || props.isFavorite || rowState === null || rowState.hovered || rowState.focused;
    const showFavoriteToggle = props.showFavoriteToggle && props.onToggleFavorite !== undefined && reached;
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const online = resolveMachinePickerPresence(props.machine, undefined, binding?.isCurrent() ? binding.scope : null).selectable;

    return (
        <View style={styles.container}>
            {/* MPG-35: the memory a reporting machine has free (or its pressure word in tone), from the held summary. */}
            {online ? <MachineMemoryFact machineId={props.machine.id} serverId={props.serverId ?? null} /> : null}
            {props.showCliGlyphs ? (
                <MachineCliGlyphs
                    machineId={props.machine.id}
                    serverId={props.serverId}
                    isOnline={online}
                    autoDetect={props.autoDetectCliGlyphs}
                />
            ) : null}
            {showFavoriteToggle ? (
                <HappierPressable
                    hitReach={0}
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
                </HappierPressable>
            ) : null}
        </View>
    );
}
