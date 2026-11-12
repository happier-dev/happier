import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { ConnectionStatusControl, type ConnectionStatusTriggerState } from '@/components/navigation/ConnectionStatusControl';

import { PhoneHomeLine } from './PhoneHomeLine';
import { PhoneAccountAvatarButton } from './PhoneAccountAvatarButton';
import { PhoneTabNavRowLine, PhoneTabNavRowProvider, usePhoneTabNavRow } from './phoneTabNavRow';

/** Space between the glyphs on the line; each one's hit area splits it, so neighbours never overlap. */
const GLYPH_ROW_GAP_PX = 2;

const styles = StyleSheet.create({
    glyphs: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: GLYPH_ROW_GAP_PX,
    },
});

const renderPhoneHomeLine = (state: ConnectionStatusTriggerState) => <PhoneHomeLine state={state} />;
const LEADING = <ConnectionStatusControl variant="header" renderTrigger={renderPhoneHomeLine} />;
const Glyphs = React.memo(function Glyphs() {
    return (
        <View style={styles.glyphs}>
            <ActionOperationActivityButton testID="main-header-action-operations" interactiveTargetGapPx={GLYPH_ROW_GAP_PX} />
            <PhoneAccountAvatarButton />
        </View>
    );
});
const TRAILING = <Glyphs />;

/** Hands a phone tab its Home line and glyphs; a column that is the whole page draws them in its own nav row. */
export function PhoneMainTabShell(props: Readonly<{ children: React.ReactNode }>) {
    return <PhoneTabNavRowProvider leading={LEADING} trailing={TRAILING}>{props.children}</PhoneTabNavRowProvider>;
}

/**
 * The head every phone main screen opens on: the Home it is on, Activity and the account avatar (owner Q4, R3).
 * `MainScreenHeader` draws it above every main screen's title; a tab shell's own line and glyphs win when present.
 */
export function PhoneMainTabLine() {
    const line = <PhoneTabNavRowLine testID="main-tab-nav-row" />;
    return usePhoneTabNavRow() ? line : <PhoneMainTabShell>{line}</PhoneMainTabShell>;
}
