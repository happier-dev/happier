import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

/**
 * A section's trailing action (`ItemGroup` `action`): a quiet text button with a glyph, such as
 * "+ Add member", "Refresh" or "Invite". It never competes with the page's one primary action.
 * An action that goes somewhere else ("Browse all") is a `destination`: its title is followed by the
 * same onward caret a destination row draws, instead of a leading glyph.
 */
export const SectionActionButton = React.memo(function SectionActionButton(props: Readonly<{
    testID?: string;
    title: string;
    /** Receives the press event, so a caller can return focus to this control. */
    onPress: (event?: unknown) => void;
    disabled?: boolean;
    loading?: boolean;
    accessibilityLabel?: string;
    /** For an action that opens something in place (a picker under the section): whether it is open. */
    expanded?: boolean;
    /** The press target's box (a header action keeps the platform's minimum target around its quiet pill). */
    style?: React.ComponentProps<typeof RoundButton>['style'];
} & (
    | Readonly<{ icon: IconName; destination?: never }>
    | Readonly<{ icon?: never; destination: true }>
)>) {
    const { theme } = useUnistyles();
    return (
        <RoundButton
            testID={props.testID}
            size="small"
            display="inverted"
            title={props.title}
            accessibilityLabel={props.accessibilityLabel}
            {...(props.destination
                ? { trailing: <Icon name="caret-right" size={14} color={theme.colors.text.secondary} /> }
                : { leading: <Icon name={props.icon} size={14} color={theme.colors.text.secondary} /> })}
            textStyle={{ color: theme.colors.text.secondary }}
            disabled={props.disabled}
            loading={props.loading}
            expanded={props.expanded}
            style={props.style}
            onPress={props.onPress}
        />
    );
});
