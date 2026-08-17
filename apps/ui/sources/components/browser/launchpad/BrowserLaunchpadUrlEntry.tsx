import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';


import { Text, TextInput } from '@/components/ui/text/Text';
import {
    type BrowserPlatformV1,
    type BrowserViewTargetV1,
} from '@happier-dev/protocol';
import { resolveExternalUrlTargetFromInput } from '@/sync/domains/browser/shell';
import { t } from '@/text';

import type { BrowserLaunchpadOpenTargetOptions } from './BrowserLaunchpad';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        marginHorizontal: 16,
        marginTop: 12,
        gap: 6,
    },
    label: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingLeft: 12,
        paddingRight: 6,
        minHeight: 44,
    },
    fieldInvalid: {
        borderColor: theme.colors.status.error,
    },
    input: {
        flex: 1,
        paddingVertical: 10,
        color: theme.colors.text.primary,
    },
    openButton: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accent.indigo,
    },
    openButtonDisabled: {
        opacity: 0.4,
    },
    invalid: {
        fontSize: 12,
        color: theme.colors.status.error,
    },
}));

/**
 * The launchpad's address box. A browser always lets the user type an address, so this row is
 * present in BOTH the zero-row empty state and the rows-present state.
 *
 * OWNER-NAV (DV-NAV): a URL submit NAVIGATES THE CURRENT tab in place via `onNavigateInPlace` —
 * the launchpad/new-tab page becomes the page — it NEVER opens a sibling workspace tab. A new tab
 * is created only from EXTERNAL surfaces (Services rows, session-header button) via OWNER-OPEN. This
 * component never opens a tab or dispatches a control command itself.
 */
export function BrowserLaunchpadUrlEntry(props: Readonly<{
    platform: BrowserPlatformV1;
    onNavigateInPlace?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-launchpad-url-entry';
    const { theme } = useUnistyles();
    const [value, setValue] = React.useState('');
    const [invalid, setInvalid] = React.useState(false);
    const disabled = !props.onNavigateInPlace;
    // The submit-time value is read from a ref so a single typed-then-submit interaction always acts
    // on the latest text even if the render that produced the submit handler has not flushed yet.
    const valueRef = React.useRef(value);
    valueRef.current = value;

    const handleChangeText = React.useCallback((next: string) => {
        valueRef.current = next;
        setValue(next);
        setInvalid(false);
    }, []);

    const handleSubmit = React.useCallback(() => {
        if (!props.onNavigateInPlace) {
            return;
        }
        const current = valueRef.current;
        if (!current.trim()) {
            setInvalid(false);
            return;
        }
        const target = resolveExternalUrlTargetFromInput(current);
        if (!target) {
            setInvalid(true);
            return;
        }
        setInvalid(false);
        valueRef.current = '';
        setValue('');
        // Navigate the CURRENT tab in place (turn the new-tab page INTO the page) — never a sibling tab.
        props.onNavigateInPlace(target, { platform: props.platform });
    }, [props]);

    return (
        <View testID={testID} style={stylesheet.root}>
            <Text style={stylesheet.label}>{t('browserLaunchpad.urlEntry.label')}</Text>
            <View style={[stylesheet.field, invalid ? stylesheet.fieldInvalid : null]}>
                <TextInput
                    testID={`${testID}-input`}
                    style={stylesheet.input}
                    value={value}
                    onChangeText={handleChangeText}
                    onSubmitEditing={handleSubmit}
                    placeholder={t('browserLaunchpad.urlEntry.placeholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    accessibilityLabel={t('browserLaunchpad.urlEntry.label')}
                    editable={!disabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="go"
                />
                <Pressable
                    testID={`${testID}-open`}
                    accessibilityRole="button"
                    accessibilityLabel={t('browserLaunchpad.urlEntry.open')}
                    disabled={disabled}
                    onPress={handleSubmit}
                    style={[stylesheet.openButton, disabled ? stylesheet.openButtonDisabled : null]}
                >
                    <Icon name="arrow-right" size={16} color={theme.colors.button.primary.tint} />
                </Pressable>
            </View>
            {invalid ? (
                <Text testID={`${testID}-invalid`} style={stylesheet.invalid}>
                    {t('browserLaunchpad.urlEntry.invalid')}
                </Text>
            ) : null}
        </View>
    );
}
