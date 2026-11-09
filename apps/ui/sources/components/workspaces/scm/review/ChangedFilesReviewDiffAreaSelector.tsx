import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import type { ThemeStyleScales } from '@/theme/themeStyleScales';

import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';

export function ChangedFilesReviewDiffAreaSelector(props: Readonly<{
    theme: Pick<ThemeStyleScales, 'space'> & Readonly<{ colors: { border: { default: string }; surface: { inset: string; base?: string }; text: { primary: string } } }>;
    diffArea: ScmDiffArea;
    availableModes: readonly ScmDiffArea[];
    labels: Readonly<Record<ScmDiffArea, string>>;
    onChange: (area: ScmDiffArea) => void;
    trailingElement?: React.ReactNode;
    inline?: boolean;
}>) {
    const { theme, diffArea, availableModes, labels, onChange, trailingElement } = props;

    const [open, setOpen] = React.useState(false);
    const items = React.useMemo(() => availableModes.map((mode) => ({
        id: mode, title: labels[mode], testID: `scm-review-diff-area-${mode}`,
    })), [availableModes, labels]);

    if (availableModes.length <= 1 && trailingElement == null) return null;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s8, paddingHorizontal: props.inline ? 0 : 16, paddingTop: props.inline ? 0 : 12, paddingBottom: props.inline ? 0 : 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
                {availableModes.length > 1 ? (
                    <DropdownMenu
                        open={open}
                        onOpenChange={setOpen}
                        items={items}
                        selectedId={diffArea}
                        onSelect={(id) => {
                            const mode = availableModes.find((mode) => mode === id);
                            if (mode) onChange(mode);
                        }}
                        search={false}
                        matchTriggerWidth={false}
                        maxWidthCap={220}
                        placement="bottom"
                        popoverAnchorAlign="start"
                        trigger={({ toggle, open: expanded }) => (
                            <Pressable
                                testID="scm-review-diff-area-menu"
                                accessibilityRole="button"
                                accessibilityLabel={labels[diffArea]}
                                accessibilityState={{ expanded }}
                                onPress={toggle}
                                style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, paddingVertical: theme.space.s6, paddingHorizontal: theme.space.s10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border.default, backgroundColor: theme.colors.surface.base ?? theme.colors.surface.inset }}
                            >
                                <Text numberOfLines={1} style={{ ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.primary,  }}>{labels[diffArea]}</Text>
                                <Icon name={expanded ? 'caret-up' : 'caret-down'} size={14} color={theme.colors.text.primary} />
                            </Pressable>
                        )}
                    />
                ) : null}
            </View>
            {trailingElement}
        </View>
    );
}
