import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { MarkdownEditMode } from '@/components/ui/markdown/editor/markdownEditorTypes';
import type { MarkdownRichIneligibleReason } from '@/components/ui/markdown/editor/core/eligibility/markdownRichEligibility';
import { resolveMarkdownRichDisabledReasonCopy } from '@/components/ui/markdown/editor/core/eligibility/markdownRichDisabledReasonCopy';

/**
 * Standalone Raw/Rich edit-mode dropdown (Lane A). Generalizes the file-pane's
 * repurposed view-mode dropdown (`FileActionToolbar`) into a reusable control so
 * the prompt/skill editor screens get the same menu without copying its markup.
 *
 * The Rich option is `disabled` (with the eligibility reason as its `subtitle`)
 * whenever `richEligible` is false; the reason copy is resolved via the shared
 * `resolveMarkdownRichDisabledReasonCopy` helper (single source of truth shared
 * with `FileActionToolbar`). Reuses the existing
 * `settingsSourceControl.markdownEditMode.*` translations.
 */

export type MarkdownEditModeMenuProps = Readonly<{
    mode: MarkdownEditMode;
    onChange: (mode: MarkdownEditMode) => void;
    richEligible: boolean;
    richDisabledReason?: MarkdownRichIneligibleReason;
    testID?: string;
}>;

const ICON_SIZE = 14;

export function MarkdownEditModeMenu(props: MarkdownEditModeMenuProps) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);

    const items = React.useMemo<DropdownMenuItem[]>(() => {
        const richDisabled = props.richEligible !== true;
        return [
            {
                id: 'raw',
                testID: 'dropdown-option-raw',
                title: t('settingsSourceControl.markdownEditMode.options.raw.title'),
                icon: <Octicons name="code" size={ICON_SIZE} color={theme.colors.text.secondary} />,
            },
            {
                id: 'rich',
                testID: 'dropdown-option-rich',
                title: t('settingsSourceControl.markdownEditMode.options.rich.title'),
                icon: <Octicons name="markdown" size={ICON_SIZE} color={theme.colors.text.secondary} />,
                disabled: richDisabled,
                subtitle: richDisabled ? resolveMarkdownRichDisabledReasonCopy(props.richDisabledReason) : undefined,
            },
        ];
    }, [props.richEligible, props.richDisabledReason, theme.colors.text.secondary]);

    // Reflect the EFFECTIVE mode in the trigger + selection, not the stored
    // preference: when Rich is selected but the file is ineligible, the editor
    // actually renders Raw, so the trigger must read "Raw" (the disabled Rich
    // option + its reason explain why). Showing "Rich" while raw is rendered is
    // misleading.
    const effectiveMode: MarkdownEditMode = props.mode === 'rich' && props.richEligible ? 'rich' : 'raw';
    const selectedLabel = effectiveMode === 'rich'
        ? t('settingsSourceControl.markdownEditMode.options.rich.title')
        : t('settingsSourceControl.markdownEditMode.options.raw.title');
    const selectedIconName = effectiveMode === 'rich' ? 'markdown' : 'code';

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={effectiveMode}
            onSelect={(itemId) => {
                if (itemId === 'raw' || itemId === 'rich') {
                    props.onChange(itemId);
                }
            }}
            matchTriggerWidth={false}
            maxWidthCap={260}
            placement="bottom"
            popoverAnchorAlign="start"
            trigger={({ toggle }) => (
                <Pressable
                    onPress={toggle}
                    testID={props.testID ?? 'markdown-edit-mode-menu'}
                    accessibilityRole="button"
                    style={{
                        minHeight: 32,
                        paddingVertical: 5,
                        paddingHorizontal: 10,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface.inset,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Octicons name={selectedIconName} size={ICON_SIZE} color={theme.colors.text.secondary} />
                        <Text
                            style={{
                                fontSize: 13,
                                fontWeight: '600',
                                color: theme.colors.text.primary,
                                ...Typography.default(),
                            }}
                            numberOfLines={1}
                        >
                            {selectedLabel}
                        </Text>
                        <Octicons name="chevron-down" size={12} color={theme.colors.text.secondary} />
                    </View>
                </Pressable>
            )}
        />
    );
}
