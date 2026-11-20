import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import type { ActiveServerSwitchResult } from '@/sync/domains/server/activeServerSwitch';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

/** Shown when a Home joined an already usable set, so changing the device's focus is explicit. */
export function ConnectedHomePane(props: Readonly<{
    profile: ServerProfile;
    onOpen?: () => Promise<ActiveServerSwitchResult>;
    onOpened: () => void;
    onShowAllHomes?: () => Promise<void>;
}>) {
    const [opening, setOpening] = React.useState(false);
    const [openFailed, setOpenFailed] = React.useState(false);
    const home = resolveHomeDisplayLabel(props.profile, props.profile.id);
    const open = React.useCallback(async () => {
        if (opening) return;
        setOpening(true);
        setOpenFailed(false);
        try {
            const result = await props.onOpen?.();
            if (result === 'blocked') setOpenFailed(true);
            else props.onOpened();
        } catch {
            setOpenFailed(true);
        } finally {
            setOpening(false);
        }
    }, [opening, props]);
    const showAll = React.useCallback(async () => {
        if (opening || !props.onShowAllHomes) return;
        setOpening(true);
        setOpenFailed(false);
        try {
            await props.onShowAllHomes();
        } catch {
            setOpenFailed(true);
        } finally {
            setOpening(false);
        }
    }, [opening, props]);
    return <View testID="add-home.connected" style={styles.body}>
        <Text accessibilityRole="header">{t('homeAdd.connectedToHome', { home })}</Text>
        <View style={styles.actions}>
            <RoundButton testID="add-home.open-home" size="small" title={t('homeAdd.openHome', { home })}
                loading={opening} onPress={() => { void open(); }} />
            {props.onShowAllHomes ? <RoundButton testID="add-home.show-all-homes" size="small" display="secondary"
                title={t('homeAdd.showAllHomes')} disabled={opening} onPress={() => { void showAll(); }} /> : null}
        </View>
        {openFailed ? <Text testID="add-home.open-failed">{t('errors.operationFailed')}</Text> : null}
    </View>;
}

const styles = StyleSheet.create(() => ({
    body: { gap: 14 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
}));
