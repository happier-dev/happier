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

import { capabilityStatusLabels, presentCapabilityStatus, type CapabilityStatus, type CapabilityStatusPlacement } from './capabilityStatusPresentation';

/**
 * A capability status where it speaks, drawn by the shared chip owner (`@happier-dev/plugin-ui` presentation)
 * with Happier's pill, small button and meta text.
 */
export const CapabilityStatusChip = React.memo(function CapabilityStatusChip(props: Readonly<{
    status: CapabilityStatus;
    placement?: CapabilityStatusPlacement;
    /** Catalog rows keep the fix in their independent action slot; the chip alone is drawn. */
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

/** The same fix binding in a row's independent action slot. */
export function CapabilityStatusFix(props: Readonly<{ status: CapabilityStatus; testID?: string }>): React.ReactElement | null {
    const presentation = presentCapabilityStatus(props.status);
    const fix = props.status.fix;
    return fix && presentation.fixLabel
        ? <ChipFix title={presentation.fixLabel} onPress={fix.onPress} testID={props.testID} />
        : null;
}

function ChipReason(props: Readonly<{ children: string }>): React.ReactElement {
    return <Text variant="meta" style={styles.reason}>{props.children}</Text>;
}

const styles = StyleSheet.create((theme) => ({
    reason: { color: theme.colors.text.secondary },
}));
