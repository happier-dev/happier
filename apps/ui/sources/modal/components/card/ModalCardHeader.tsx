import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierModalHeader, type HappierModalHeaderTextRender, type HappierStyleProp } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';

import { ModalCloseButton } from './ModalCloseButton';

type ModalCardHeaderProps = Readonly<{
    leading?: React.ReactNode;
    leadingPlacement?: 'above' | null;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    subtitleLines?: 1 | 2;
    actions?: React.ReactNode;
    /** A form's completion control (Done) in the close control's place: it keeps the title's row on a phone too. */
    completion?: React.ReactNode;
    onClose?: () => void;
    /** `wide`: the band stands on the content's 24 edge; a phone keeps the page gutter. */
    inset?: 'wide';
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    title: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));

/**
 * Happier core's binding of the shared task-modal title band (`HappierModalHeader`): the app's text,
 * density-scaled spacing, close control and phone decision. Layout and the phone rule live in plugin-ui.
 * Search and the command palette pass `header: 'none'` to the card chrome and render none.
 */
export function ModalCardHeader(props: ModalCardHeaderProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const compact = useDeviceType() === 'phone';
    const subtitleLines = props.subtitleLines;
    const renderText = React.useCallback<HappierModalHeaderTextRender>((input) => (
        <Text
            testID={input.testID}
            style={input.role === 'title' ? styles.title : styles.subtitle}
            numberOfLines={input.role === 'subtitle' ? subtitleLines : undefined}
        >{input.children}</Text>
    ), [styles, subtitleLines]);

    return (
        <HappierModalHeader
            leading={props.leading}
            {...(props.leadingPlacement ? { leadingPlacement: props.leadingPlacement } : {})}
            title={props.title}
            subtitle={props.subtitle}
            actions={props.actions}
            close={props.completion != null ? props.completion : typeof props.onClose === 'function'
                ? <ModalCloseButton testID={props.closeButtonTestID} onPress={props.onClose} />
                : null}
            compact={compact}
            space={theme.space}
            renderText={renderText}
            testID={props.testID}
            titleTestID={props.titleTestID}
            subtitleTestID={props.subtitleTestID}
            // The app's own header style overrides (a card's `headerStyle`) are React Native view styles.
            style={[props.inset === 'wide' && !compact ? { paddingHorizontal: theme.space.s24 } : null, props.style] as HappierStyleProp}
        />
    );
}
