import * as React from 'react';
import { View, type NativeSyntheticEvent, type TextInput as RNTextInput, type TextInputKeyPressEventData } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { TextInput } from '@/components/ui/text/Text';
import { formatBrowserDisplayUrl, normalizeBrowserAddressInput } from '@/sync/domains/browser/shell';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    input: {
        flex: 1,
        minWidth: 0,
        height: 34,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        color: theme.colors.text.primary,
        paddingHorizontal: 10,
        paddingVertical: 0,
    },
}));

const NO_SELECTION = undefined;

export function BrowserAddressField(props: Readonly<{
    value: string;
    disabled?: boolean;
    searchUrlTemplate?: string;
    onNavigate: (url: string) => void;
    testID?: string;
}>): React.ReactElement {
    const inputRef = React.useRef<RNTextInput | null>(null);
    const copyFeedback = useTemporaryCopyFeedback();
    const [focused, setFocused] = React.useState(false);
    const [rawDraft, setRawDraft] = React.useState(props.value);
    const [selection, setSelection] = React.useState<Readonly<{ start: number; end: number }> | undefined>(NO_SELECTION);

    // Keep the editable draft in sync with the authoritative value while blurred so
    // navigations driven elsewhere (redirects, programmatic loads) are reflected on
    // the next focus without clobbering an in-progress edit.
    React.useEffect(() => {
        if (!focused) {
            setRawDraft(props.value);
        }
    }, [focused, props.value]);

    const displayValue = focused ? rawDraft : formatBrowserDisplayUrl(props.value);

    const handleFocus = React.useCallback(() => {
        setFocused(true);
        setRawDraft(props.value);
        setSelection({ start: 0, end: props.value.length });
    }, [props.value]);

    const handleBlur = React.useCallback(() => {
        setFocused(false);
        setSelection(NO_SELECTION);
    }, []);

    const handleChangeText = React.useCallback((next: string) => {
        // Once the user types, stop forcing the select-all range so the caret behaves.
        setSelection(NO_SELECTION);
        setRawDraft(next);
    }, []);

    const submit = React.useCallback(() => {
        if (props.disabled) return;
        const normalized = normalizeBrowserAddressInput(rawDraft, {
            searchUrlTemplate: props.searchUrlTemplate,
        });
        if (normalized.ok) {
            props.onNavigate(normalized.url);
        }
    }, [props, rawDraft]);

    const handleKeyPress = React.useCallback((event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (event.nativeEvent.key !== 'Escape') {
            return;
        }
        setRawDraft(props.value);
        setSelection(NO_SELECTION);
        setFocused(false);
        inputRef.current?.blur();
    }, [props.value]);

    const handleCopyUrl = React.useCallback(async () => {
        if (!props.value || props.disabled) return;
        const copied = await setClipboardStringSafe(props.value);
        if (copied) {
            copyFeedback.markCopied('url');
        }
    }, [copyFeedback, props.disabled, props.value]);

    return (
        <View style={stylesheet.root}>
            <TextInput
                ref={inputRef}
                testID={props.testID}
                value={displayValue}
                editable={!props.disabled}
                selection={selection}
                selectTextOnFocus
                onFocus={handleFocus}
                onBlur={handleBlur}
                onChangeText={handleChangeText}
                onKeyPress={handleKeyPress}
                onSubmitEditing={submit}
                accessibilityLabel={t('browserShell.address.label')}
                placeholder={t('browserShell.address.placeholder')}
                autoCapitalize="none"
                autoCorrect={false}
                inputMode="url"
                returnKeyType="go"
                style={stylesheet.input}
            />
            <IconButton
                testID={props.testID ? `${props.testID}-copy` : undefined}
                iconName="copy-outline"
                accessibilityLabel={t('browserShell.address.copy')}
                tooltip={t('browserShell.address.copy')}
                size={34}
                iconSize={16}
                disabled={!props.value || props.disabled}
                onPress={handleCopyUrl}
            />
            <CopiedPill
                visible={copyFeedback.isCopied('url')}
                testID={props.testID ? `${props.testID}-copy-feedback` : undefined}
            />
        </View>
    );
}
