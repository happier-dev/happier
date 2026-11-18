import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierNoticeLine, type HappierNoticeLineTextRender } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Text } from '@/components/ui/text/Text';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

/**
 * Core's binding of the shared compact status line (`HappierNoticeLine`): a glyph (its tooltip carries
 * the detail), what the line is about, its status, and at most one next step as an icon-only control.
 * Provider errors and a request waiting for its approval share it, so a picker's summary reads as one
 * list of lines.
 */
export const NoticeLine = React.memo(function NoticeLine(props: Readonly<{
    testID: string;
    tooltipTestID?: string;
    iconName: IconName;
    iconColor: string;
    tooltip?: string;
    /** What the line is about (a model); it truncates first, so the title always stays readable. */
    subject?: string | null;
    title: string;
    /** A consequence sentence wraps under its glyph instead of truncating like a status. */
    wrap?: boolean;
    action?: Readonly<{
        testID?: string;
        label: string;
        iconName: IconName;
        disabled?: boolean;
        onPress: (event?: unknown) => void;
    }>;
}>) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const icon = <Icon name={props.iconName} size={ICON_SIZE.sm} color={props.iconColor} />;
    return (
        <HappierNoticeLine
            testID={props.testID}
            theme={presentationTheme}
            subject={props.subject}
            title={props.title}
            renderText={props.wrap ? renderWrappingNoticeLineText : renderNoticeLineText}
            icon={props.tooltip ? <Tooltip testID={props.tooltipTestID} label={props.tooltip}>{icon}</Tooltip> : icon}
            action={props.action ? (
                <IconButton
                    testID={props.action.testID}
                    iconName={props.action.iconName}
                    accessibilityLabel={props.action.label}
                    tooltip={props.action.label}
                    variant="plain"
                    size={24}
                    iconSize={ICON_SIZE.sm}
                    disabled={props.action.disabled}
                    onPress={props.action.onPress}
                />
            ) : undefined}
        />
    );
});

/** App `Text`, so in-app font scaling applies; the line's layout and type role stay the shared owner's. */
const renderWrappingNoticeLineText: HappierNoticeLineTextRender = (input) => (
    <Text testID={input.testID} style={input.style as React.ComponentProps<typeof Text>['style']}>{input.text}</Text>
);

const renderNoticeLineText: HappierNoticeLineTextRender = (input) => (
    <Text testID={input.testID} numberOfLines={1} style={input.style as React.ComponentProps<typeof Text>['style']}>{input.text}</Text>
);
