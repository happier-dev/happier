import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import {
    DropdownMenu,
    type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { SourceControlUpdateTheme } from './SourceControlUpdateControls';

export type SourceControlUpdateDropdownItem = DropdownMenuItem;

export function SourceControlUpdateDropdown(props: Readonly<{
    theme: SourceControlUpdateTheme;
    label: string;
    testID: string;
    items: readonly SourceControlUpdateDropdownItem[];
    selectedId: string;
    disabled?: boolean;
    onSelect: (itemId: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const selectedItem = props.items.find((item) => item.id === props.selectedId) ?? null;
    const disabled = props.disabled === true || props.items.length === 0;

    return (
        <View style={{ gap: 6 }}>
            <Text
                style={{
                    fontSize: 11,
                    color: props.theme.colors.textSecondary,
                    ...Typography.default('semiBold'),
                }}
            >
                {props.label}
            </Text>
            <DropdownMenu
                open={open}
                onOpenChange={setOpen}
                selectedId={props.selectedId}
                items={props.items}
                onSelect={(itemId) => {
                    props.onSelect(itemId);
                    setOpen(false);
                }}
                rowKind="item"
                variant="selectable"
                search={false}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                popoverPortalWebTarget="body"
                trigger={({ open: menuOpen, toggle }) => (
                    <Pressable
                        testID={props.testID}
                        accessibilityRole="button"
                        accessibilityLabel={props.label}
                        accessibilityState={{ expanded: menuOpen, disabled }}
                        disabled={disabled}
                        hitSlop={8}
                        onPress={toggle}
                        style={({ pressed }) => ({
                            minHeight: 36,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: props.theme.colors.input?.border ?? props.theme.colors.divider,
                            backgroundColor: props.theme.colors.input?.background ?? props.theme.colors.surfaceHigh,
                            paddingHorizontal: 10,
                            paddingVertical: 7,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            opacity: disabled ? 0.55 : pressed ? 0.82 : 1,
                        })}
                    >
                        <Text
                            numberOfLines={1}
                            style={{
                                flex: 1,
                                fontSize: 12,
                                color: props.theme.colors.input?.text ?? props.theme.colors.text,
                                ...Typography.default('semiBold'),
                            }}
                        >
                            {selectedItem?.title ?? ''}
                        </Text>
                        <Octicons
                            name={menuOpen ? 'chevron-up' : 'chevron-down'}
                            size={14}
                            color={props.theme.colors.textSecondary}
                        />
                    </Pressable>
                )}
            />
        </View>
    );
}
