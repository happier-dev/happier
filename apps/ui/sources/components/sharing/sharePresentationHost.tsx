import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ITEM_CHEVRON_SIZE } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import type { ShareGrantRowPresentation } from '@happier-dev/plugin-ui/components';
import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { HappierShareChoiceProps, HappierShareHost, HappierShareTextProps, HappierShareSheetButtonProps } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';

const styles = StyleSheet.create(theme => ({
    primary: { color: theme.colors.text.primary },
    secondary: { color: theme.colors.text.secondary },
    selected: { color: theme.colors.text.link },
    strong: { color: theme.colors.text.primary, fontWeight: '600' },
    destructive: { color: theme.colors.state.danger.foreground },
}));

function ShareText({ tone = 'primary', ...props }: HappierShareTextProps) {
    return <Text {...props} style={styles[tone]} />;
}

/** A grant's levels on the app's one segmented value control, with its sliding thumb. */
function ShareLevelChoice(props: HappierShareChoiceProps) {
    const selected = props.choices.find(choice => choice.selected)?.id ?? '';
    return <SegmentedTabBar role="radiogroup" segmentSizing="content" accessibilityLabel={props.accessibilityLabel}
        disabled={props.disabled} activeTabId={selected}
        tabs={props.choices.map(choice => ({ id: choice.id, label: choice.label, disabled: choice.disabled, testID: choice.testID }))}
        onSelectTab={id => { const choice = props.choices.find(entry => entry.id === id); if (choice && !choice.selected) void choice.onPress(); }} />;
}

/** Theme/typography only; sharing authority and interaction state stay in the app controllers. */
export function useSharePresentationHost(): HappierShareHost {
    const { theme } = useUnistyles();
    return { Text: ShareText, Choice: ShareLevelChoice, focusColor: theme.colors.border.focus, borderColor: theme.colors.border.subtle,
        noteColor: theme.colors.surface.elevated };
}

export function ShareSheetButton({ label, emphasis, leading, style, ...props }: HappierShareSheetButtonProps & Readonly<{ loading?: boolean }>) {
    return <RoundButton {...props} title={label} size="small" display={emphasis === 'secondary' ? 'inverted' : undefined}
        leading={leading} style={style} titleNumberOfLines="complete" />;
}

export function useShareGrantRowPresentation(): ShareGrantRowPresentation {
    const host = useSharePresentationHost();
    const { theme } = useUnistyles();
    const density = useResolvedItemDensity();
    return { host, accessLevel: t('shareSheet.accessLevel'), remove: t('shareSheet.remove'),
        confirmRemove: t('shareSheet.confirmRemove'), cancel: t('common.cancel'), retry: t('common.retry'),
        accessibleControl: (name, value) => t('shareSheet.accessibleControl', { name, control: t('shareSheet.accessLevel'), value }),
        lock: testID => <Icon name="lock" size={ICON_SIZE.sm} color={theme.colors.text.secondary} testID={testID} />,
        caret: () => <Icon name="caret-down" size={ITEM_CHEVRON_SIZE[density]} color={theme.colors.text.secondary} /> };
}
