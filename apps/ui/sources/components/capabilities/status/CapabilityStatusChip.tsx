import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierCapabilityStatusChip,
    type HappierCapabilityStatusFixProps,
    type HappierCapabilityStatusPillProps,
} from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { StatusPill } from '@/components/ui/status/StatusPill';

import { capabilityStatusLabels, type CapabilityStatus, type CapabilityStatusPlacement } from './capabilityStatusPresentation';

/**
 * A capability status where it speaks, drawn by the shared chip owner (`@happier-dev/plugin-ui` presentation)
 * with Happier's pill, small button and meta text.
 */
export const CapabilityStatusChip = React.memo(function CapabilityStatusChip(props: Readonly<{
    status: CapabilityStatus;
    placement?: CapabilityStatusPlacement;
    /** In a list's facts line the fix stays in the row's action column; the chip alone is drawn. */
    showFix?: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <HappierCapabilityStatusChip
            {...props}
            labels={capabilityStatusLabels}
            Pill={ChipPill}
            Fix={ChipFix}
            Reason={ChipReason}
            space={theme.space}
        />
    );
});

function ChipPill(props: HappierCapabilityStatusPillProps): React.ReactElement {
    return (
        <StatusPill
            variant={props.variant}
            chrome={props.chrome}
            label={props.label}
            labelVariant="phrase"
            hideDot={props.placement === 'catalog'}
            {...(props.placement === 'catalog' ? {} : { labelNumberOfLines: 1 })}
            {...(props.detail === undefined ? {} : { detail: props.detail })}
        />
    );
}

function ChipFix(props: HappierCapabilityStatusFixProps): React.ReactElement {
    return <RoundButton size="small" display="secondary" title={props.title} onPress={props.onPress} {...(props.testID === undefined ? {} : { testID: props.testID })} />;
}

function ChipReason(props: Readonly<{ children: string }>): React.ReactElement {
    return <Text variant="meta" style={styles.reason}>{props.children}</Text>;
}

const styles = StyleSheet.create((theme) => ({
    reason: { color: theme.colors.text.secondary },
}));
