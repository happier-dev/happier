import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';
import { BrowserSurfaceOpenButton } from '@/components/browser/surfaces/BrowserSurfaceOpenButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

/** The row's gap (`container`): neighbouring actions' hit areas split it. */
const ACTION_GAP_PX = 4;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingRight: theme.space.s8,
        // A phone head's Machine chip gives up its width first (its name ellipsizes), never the launchers.
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
}));

/**
 * The phone Project bar's controls: the Project's launchers (worktrees, browser, Terminal). They are
 * plain icon buttons in the header's own glyph colour, like the Session header's (DESIGN.md: icon
 * buttons carry no edge). The phone File page has no tab strip, so the bar is where the browser
 * launcher lives there (lab FV1p); the Details strip leaves it, and Terminal, to the bar.
 */
export type ProjectHeaderActionsProps = Readonly<{
    testIdPrefix: string;
    showWorktreesButton: boolean;
    showWorkspaceExperienceButton?: boolean;
    workspaceExperienceToggleA11yLabel?: string;
    onToggleWorkspaceExperience?: () => void;
    onOpenWorktrees?: () => void;
    onOpenBrowser?: () => void;
    /** Absent where the Project cockpit bar is on screen: Terminal lives in the bar and its ⋯ there. */
    onOpenTerminal?: () => void;
    /** A phone page's own head (`ProjectPhoneHead`): its Machine chip before the launchers, its ⋯ after them. */
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
}>;

export const ProjectHeaderActions = React.memo((props: ProjectHeaderActionsProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const glyphColor = theme.colors.chrome.header.foreground;
    const size = HAPPIER_PAGE_METRICS.controlHeightPx;
    const glyph = (name: React.ComponentProps<typeof Icon>['name']) => <Icon name={name} size={ICON_SIZE.sm} color={glyphColor} />;

    return (
        <View style={styles.container}>
            {props.leading}
            {props.showWorkspaceExperienceButton && props.onToggleWorkspaceExperience && props.workspaceExperienceToggleA11yLabel ? (
                <IconButton
                    testID={`${props.testIdPrefix}-toggle-workspace-experience`}
                    variant="plain"
                    size={size}
                    interactiveTargetGapPx={ACTION_GAP_PX}
                    onPress={props.onToggleWorkspaceExperience}
                    accessibilityLabel={props.workspaceExperienceToggleA11yLabel}
                    icon={glyph('arrows-left-right')}
                />
            ) : null}
            {props.showWorktreesButton && props.onOpenWorktrees ? (
                <IconButton
                    testID={`${props.testIdPrefix}-open-worktrees`}
                    variant="plain"
                    size={size}
                    interactiveTargetGapPx={ACTION_GAP_PX}
                    onPress={props.onOpenWorktrees}
                    accessibilityLabel={t('files.branchMenu.category.worktrees')}
                    icon={glyph('git-branch')}
                />
            ) : null}
            {props.onOpenBrowser ? (
                <BrowserSurfaceOpenButton
                    testID={`${props.testIdPrefix}-open-browser`}
                    size={size}
                    iconColor={glyphColor}
                    interactiveTargetGapPx={ACTION_GAP_PX}
                    onPress={props.onOpenBrowser}
                />
            ) : null}
            {props.onOpenTerminal ? (
                <IconButton
                    testID={`${props.testIdPrefix}-open-terminal`}
                    variant="plain"
                    size={size}
                    interactiveTargetGapPx={ACTION_GAP_PX}
                    onPress={props.onOpenTerminal}
                    accessibilityLabel={t('settings.terminal')}
                    icon={glyph('terminal')}
                />
            ) : null}
            {props.trailing}
        </View>
    );
});
