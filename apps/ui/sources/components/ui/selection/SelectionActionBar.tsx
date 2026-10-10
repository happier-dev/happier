import {
    HappierSelectionActionBar,
    type HappierSelectionActionBarHost,
    type HappierSelectionActionBarOverflowItem,
    type HappierSelectionActionBarProps,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
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
            trigger={({ toggle }) => <>{props.renderTrigger(toggle)}</>}
        />
    );
}

const CORE_SELECTION_BAR_HOST: HappierSelectionActionBarHost = {
    Text: CoreSelectionBarText,
    OverflowMenu: CoreSelectionBarOverflowMenu,
    renderGlyph: (glyph, color, size) => <Icon name={glyph === 'dismiss' ? 'x' : 'dots-three'} size={size} color={color} />,
};

export type SelectionActionBarProps = Omit<HappierSelectionActionBarProps, 'colors' | 'host' | 'reducedMotion' | 'moreLabel'>;

/**
 * Happier core's binding of the ONE selection action bar (`HappierSelectionActionBar` in
 * `@happier-dev/plugin-ui/presentation`, the same owner behind a plugin's `List.SelectionActionBar`).
 * It supplies only what the runtime owns: app typography (font scale), the icon pack, the anchored
 * menu, the reduced-motion preference and the inverted primary-button colour pair. Keyboard Esc stays
 * with each selection owner (session list layer, transcript shortcut), never a second handler here.
 */
export function SelectionActionBar(props: SelectionActionBarProps): React.ReactElement | null {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const colors = React.useMemo(() => ({
        background: theme.colors.button.primary.background,
        foreground: theme.colors.button.primary.tint,
        destructive: theme.colors.state.danger.foreground,
    }), [theme.colors.button.primary.background, theme.colors.button.primary.tint, theme.colors.state.danger.foreground]);
    return (
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
}
