import {
    HappierSelectionActionBar,
    HAPPIER_SELECTION_ACTION_BAR_HEIGHT_PX,
    type HappierSelectionActionBarHost,
    type HappierSelectionActionBarOverflowItem,
    type HappierSelectionActionBarProps,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useOptionalSafeAreaInsets } from '@/hooks/ui/useOptionalSafeAreaInsets';
import { useSessionCockpitPageBottomClearance } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { t } from '@/text';
import { renderThemeMaterialSurface } from '@/components/ui/glass/GlassSurface';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';

function CoreSelectionBarText(props: React.ComponentProps<HappierSelectionActionBarHost['Text']>): React.ReactElement {
    return (
        <Text
            style={(props.tabularNumbers
                ? [props.style, Typography.tabular()]
                : props.style) as React.ComponentProps<typeof Text>['style']}
            numberOfLines={props.numberOfLines}
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
        >
            {props.children}
        </Text>
    );
}

function CoreSelectionBarOverflowMenu(props: Readonly<{
    items: readonly HappierSelectionActionBarOverflowItem[];
    onSelect: (id: string) => void;
    accessibilityLabel: string;
    renderTrigger: (open: () => void) => React.ReactNode;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={props.items.map((item) => ({
                id: item.id,
                title: item.label,
                ...(item.disabled ? { disabled: true } : {}),
                ...(item.destructive ? { destructive: true } : {}),
                ...(item.testID ? { testID: item.testID } : {}),
            }))}
            onSelect={(id) => {
                setOpen(false);
                props.onSelect(id);
            }}
            matchTriggerWidth={false}
            placement="top"
            popoverAnchorAlign="end"
            // The trigger itself (no Fragment around it), so the menu can mark it expanded.
            trigger={({ toggle }) => props.renderTrigger(toggle)}
        />
    );
}

const CORE_SELECTION_BAR_HOST: HappierSelectionActionBarHost = {
    Text: CoreSelectionBarText,
    OverflowMenu: CoreSelectionBarOverflowMenu,
    renderGlyph: (glyph, color, size) => <Icon name={glyph === 'dismiss' ? 'x' : 'dots-three'} size={size} color={color} />,
};

export type SelectionActionBarProps = Omit<HappierSelectionActionBarProps, 'colors' | 'host' | 'reducedMotion' | 'moreLabel'> & Readonly<{
    /**
     * `pinned`: the page's one bottom action bar. It floats over the bottom of its page, above the shell's floating
     * bottom chrome (a phone's tab bar) or the safe area, and the page keeps `SELECTION_ACTION_BAR_RESERVE_PX` clear
     * under its last content while it shows. Its parent is the page's own frame, not its scroll content.
     */
    placement?: 'inline' | 'pinned';
}>;

/** The gap the pinned bar keeps above whatever is under it, and above the page's last content. */
const PINNED_GAP_PX = 12;
/** What a page reserves under its last content while its pinned bar shows, so nothing ends behind the bar. */
export const SELECTION_ACTION_BAR_RESERVE_PX = HAPPIER_SELECTION_ACTION_BAR_HEIGHT_PX + PINNED_GAP_PX * 2;

/**
 * Happier core's binding of the ONE selection action bar (`HappierSelectionActionBar` in
 * `@happier-dev/plugin-ui/presentation`, the same owner behind a plugin's `List.SelectionActionBar`).
 * It supplies only what the runtime owns: app typography (font scale), the icon pack, the anchored
 * menu, the reduced-motion preference and the inverted primary-button colour pair. Keyboard Esc stays
 * with each selection owner (session list layer, transcript shortcut), never a second handler here.
 */
export function SelectionActionBar({ placement, ...props }: SelectionActionBarProps): React.ReactElement | null {
    const { theme } = useUnistyles();
    const bottomChrome = useSessionCockpitPageBottomClearance();
    const safeArea = useOptionalSafeAreaInsets();
    const reducedMotion = useReducedMotionPreference();
    // The inverse fill is near black/white: the glass fixed point (its fill over the plain page) can only reach it with a ~full coat, so the rail paints opaque by design.
    const colors = React.useMemo(() => ({
        background: theme.colors.button.primary.background,
        foreground: theme.colors.button.primary.tint,
        destructive: theme.colors.state.danger.foreground,
        destructiveText: theme.colors.state.danger.textForeground,
    }), [theme.colors.button.primary.background, theme.colors.button.primary.tint,
        theme.colors.state.danger.foreground, theme.colors.state.danger.textForeground]);
    const bar = (
        <HappierSelectionActionBar
            {...props}
            colors={colors}
            host={CORE_SELECTION_BAR_HOST}
            reducedMotion={reducedMotion}
            moreLabel={t('common.moreActions')}
            gradient={resolveThemeSurfaceFinish(theme, 'floating')}
            renderMaterialSurface={renderThemeMaterialSurface}
        />
    );
    if (placement !== 'pinned') return bar;
    // Above the floating bottom chrome when the shell draws one (it reports its height), else above the safe area.
    const bottom = (bottomChrome > 0 ? bottomChrome : safeArea.bottom) + PINNED_GAP_PX;
    return <View pointerEvents="box-none" style={[styles.pinned, { bottom }]}>{bar}</View>;
}

const styles = StyleSheet.create((theme) => ({
    pinned: { position: 'absolute', left: theme.space.s16, right: theme.space.s16, zIndex: 30, elevation: 30, alignItems: 'center' },
}));
