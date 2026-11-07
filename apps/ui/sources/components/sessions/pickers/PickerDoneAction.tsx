import React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * The Done action of a detailed picker lives in the detail pane's header line, beside the
 * refresh control, instead of in a separate row above the picker.
 *
 * The picker panel owns the action and provides it here. A pane header that has an actions
 * slot (`OptionPickerOverlay`) claims it and renders Done to the left of its refresh control;
 * when no header claims it, the panel renders Done in its own pane-header slot, so a detail
 * pane without a refresh control never loses the action. The first claimant hosts it, so a
 * pane with several headers still shows exactly one Done.
 */
type PickerDoneHost = Readonly<{
    onDone: () => void;
    hostId: string | null;
    claim: (id: string) => () => void;
}>;

const PickerDoneHostContext = React.createContext<PickerDoneHost | null>(null);

export function usePickerDoneHost(onDone: (() => void) | undefined): Readonly<{
    value: PickerDoneHost | null;
    hosted: boolean;
}> {
    const onDoneRef = React.useRef(onDone);
    React.useEffect(() => {
        onDoneRef.current = onDone;
    });
    const enabled = typeof onDone === 'function';
    const [hostIds, setHostIds] = React.useState<ReadonlyArray<string>>([]);
    const claim = React.useCallback((id: string) => {
        setHostIds((current) => (current.includes(id) ? current : [...current, id]));
        return () => setHostIds((current) => current.filter((candidate) => candidate !== id));
    }, []);
    const handleDone = React.useCallback(() => {
        onDoneRef.current?.();
    }, []);
    const hostId = hostIds[0] ?? null;
    const value = React.useMemo<PickerDoneHost | null>(
        () => (enabled ? { onDone: handleDone, hostId, claim } : null),
        [claim, enabled, handleDone, hostId],
    );
    return { value, hosted: enabled && hostId !== null };
}

export const PickerDoneHostProvider = PickerDoneHostContext.Provider;

/** Claims the surrounding picker's Done action for this header; returns it when this header hosts it. */
export function usePickerHostedDone(): (() => void) | null {
    const host = React.useContext(PickerDoneHostContext);
    const id = React.useId();
    const claim = host?.claim;
    React.useLayoutEffect(() => (claim ? claim(id) : undefined), [claim, id]);
    return host && host.hostId === id ? host.onDone : null;
}

export function PickerDoneButton(props: Readonly<{ onPress: () => void }>) {
    const styles = stylesheet;
    return (
        <PressableSurface
            // Kept from the former separate Done row so existing automation keeps resolving it.
            testID="agent-input-chip-picker.done"
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
            onPress={props.onPress}
            focusRingRadius={9}
            style={styles.button}
        >
            <Text style={styles.label}>✓ {t('common.done')}</Text>
        </PressableSurface>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    button: {
        height: 28,
        paddingHorizontal: 10,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    label: {
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
}));
