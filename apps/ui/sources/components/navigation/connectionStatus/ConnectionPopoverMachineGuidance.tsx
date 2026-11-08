import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { presentThisComputerConnection } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import {
    useAppAccountIdentity,
    useThisComputerConnection,
} from '@/components/settings/machines/localControl/useThisComputerConnection';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { fireAndForget } from '@/utils/system/fireAndForget';


const stylesheet = StyleSheet.create((theme) => ({
    // A menu note: the rows' text inset and the menu's row rhythm (`MENU_ROW_METRICS`).
    root: {
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingVertical: MENU_ROW_METRICS.paddingVerticalPx,
        gap: MENU_ROW_METRICS.paddingVerticalPx,
    },
    message: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
}));

/**
 * The popover's "no machines" explanation. Mounted only while the popover is open and the signed-in
 * account has no machines, so its local status read never runs for closed chrome.
 *
 * On desktop the shared this-computer owner names why this computer is not one of the account's
 * machines (another account, another Home, stopped…) and offers the page that repairs it; otherwise
 * one sentence names the account and the Home, with setup as the one action.
 */
export function ConnectionPopoverMachineGuidance(props: Readonly<{
    /** The Home's display name, exactly as the popover's Home row names it. */
    homeLabel: string;
    onClose: () => void;
}>): React.ReactElement {
    const styles = stylesheet;
    const router = useRouter();
    const { status } = useLocalDaemonControl();
    const connection = useThisComputerConnection(status);
    const { accountLabel } = useAppAccountIdentity();
    const presentation = connection ? presentThisComputerConnection(connection) : null;

    const message = presentation
        ? presentation.description
        : t('machine.thisComputer.noComputers', {
            home: props.homeLabel,
            appAccount: resolveViewerAccountDisplayName(accountLabel),
        });
    const actionLabel = presentation
        ? t('machine.thisComputer.openThisComputer')
        : t('setupOnboarding.openSetupAction');

    const onClose = props.onClose;
    const opensThisComputer = presentation != null;
    const handleAction = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push(opensThisComputer
            ? SETTINGS_ROUTES.machinesThisComputer
            : buildMachineAddHref({ path: 'thisComputer' })));
        if (result !== true) {
            fireAndForget(result, { tag: 'ConnectionPopoverMachineGuidance.nav' });
        }
        onClose();
    }, [onClose, opensThisComputer, router]);

    return (
        <View style={styles.root} testID="connection-popover-machine-guidance">
            <Text style={styles.message} testID="connection-popover-machine-guidance-message">
                {message}
            </Text>
            <View style={styles.actions}>
                <ToolbarButton
                    testID="connection-popover-machine-guidance-action"
                    label={actionLabel}
                    onPress={handleAction}
                />
            </View>
        </View>
    );
}
