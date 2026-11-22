import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';

import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The head of a page behind the Storage tab (lab `rs` `subHead`): the machine tab sub-head with Storage's way back.
 * Worktrees, Suggestions, a kind's page and Protected folders share it.
 */
export function StoragePageHead(props: Readonly<{ title: string; onBack: () => void; children?: React.ReactNode }>) {
    return (
        <MachineTabSubHead title={props.title} back={{ label: t('machineStorage.page.back'), onPress: props.onBack, testID: 'machine-storage-page-back' }}>
            {props.children}
        </MachineTabSubHead>
    );
}

/**
 * A quiet line of reassurance under a Storage list, on the rows' edge (lab `rs` `hint`): what Happier
 * reads, what a scan skips, when a suggestion appears.
 */
export function StorageHint(props: Readonly<{ icon: IconName; text: string }>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup surface="none" header="none">
            <View style={styles.hint}>
                <Icon name={props.icon} size={14} color={theme.colors.text.tertiary} />
                <Text style={styles.hintText}>{props.text}</Text>
            </View>
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    hintText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        flex: 1,
    },
}));
