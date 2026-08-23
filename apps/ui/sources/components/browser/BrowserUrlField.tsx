import * as React from 'react';
import { Platform, View, type NativeSyntheticEvent, type TextInput as RNTextInput, type TextInputKeyPressEventData } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    formatBrowserDisplayUrl,
    normalizeBrowserAddressInput,
    type BrowserAddressNormalizationResult,
} from '@/sync/domains/browser/shell';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

/**
 * How much room the field has. `toolbar` is the 34px chrome row above a rendered page; `panel` is
 * the 44px entry on the launchpad, where the field is the primary thing on screen and gets a real
 * touch target.
 */
export type BrowserUrlFieldDensity = 'toolbar' | 'panel';

/**
 * The single trailing affordance inside the field. `copy` puts the authoritative URL on the
 * clipboard (the toolbar's address bar); `go` submits (the launchpad's entry box). Both are
 * URL-field concerns, which is why they live here rather than being passed in as a slot — a slot
 * would let the two call sites drift apart again.
 */
export type BrowserUrlFieldTrailingAction = 'copy' | 'go' | 'none';

const DENSITY = {
    toolbar: { height: 34, radius: 8, paddingLeft: 10, paddingRight: 3, button: 28, iconSize: 15 },
    panel: { height: 44, radius: 11, paddingLeft: 12, paddingRight: 6, button: 32, iconSize: 17 },
} as const satisfies Record<BrowserUrlFieldDensity, Readonly<{
    height: number;
    radius: number;
    paddingLeft: number;
    paddingRight: number;
    button: number;
    iconSize: number;
}>>;

const NO_SELECTION = undefined;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        minWidth: 0,
        gap: 4,
    },
    label: {
        ...Typography.eyebrow(),
        color: theme.colors.text.secondary,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    // Focus-visible is the same treatment `IconButton` uses for its focus ring, so keyboard focus
    // reads identically across the chrome instead of only being tracked and never drawn.
    fieldRowFocused: {
        borderColor: theme.colors.border.strong,
    },
    fieldRowInvalid: {
        borderColor: theme.colors.status.error,
    },
    input: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
        paddingVertical: 0,
        // An explicit size is load-bearing, not decoration: `TextInput` only engages the iOS-web
        // 16px zoom guard when it can resolve a font size, and without one Safari zooms the whole
        // page on focus. It is also what gives `uiFontScale` a line box to scale.
        ...Typography.rowMeta(),
    },
    message: {
        ...Typography.rowMeta(),
        color: theme.colors.status.error,
    },
    copiedPill: {
        position: 'absolute',
        right: 0,
        top: '100%',
        marginTop: 4,
    },
}));

function messageForResult(result: BrowserAddressNormalizationResult): string | null {
    if (result.ok) return null;
    switch (result.reasonCode) {
        case 'empty':
            return null;
        case 'search_unconfigured':
            return t('browserShell.address.searchUnconfigured');
        case 'invalid_url':
            return t('browserShell.address.invalid');
    }
}

export type BrowserUrlFieldProps = Readonly<{
    testID: string;
    /** The authoritative URL this field reflects. Empty for a new-tab entry box. */
    value: string;
    disabled?: boolean;
    density?: BrowserUrlFieldDensity;
    /** Optional eyebrow above the field (the launchpad names its entry box). */
    label?: string;
    placeholder?: string;
    accessibilityLabel?: string;
    trailingAction?: BrowserUrlFieldTrailingAction;
    /**
     * Prettify the blurred value (drop the scheme, `www.`, and a bare trailing slash). The address
     * bar reflects a loaded page and wants this; the launchpad's entry box starts empty and does not.
     */
    formatWhileBlurred?: boolean;
    /** Clear the draft after a successful submit (a new-tab entry box, not an address bar). */
    clearOnSubmit?: boolean;
    searchUrlTemplate?: string;
    onSubmitUrl: (url: string) => void;
}>;

/**
 * The ONE browser URL entry field.
 *
 * It replaced two near-identical implementations whose only real difference was how they FAILED:
 * the toolbar's address bar dropped unparseable input on the floor with no message, no navigation
 * and no hint, while the launchpad's entry box showed an inline error for the same input. Both now
 * run the same canonical normalizer ({@link normalizeBrowserAddressInput}) and report the same
 * three outcomes — navigate, "that is not an address", or "search is not configured" — so a typed
 * query can never silently do nothing again.
 *
 * The trailing control lives inside the field's border rather than beside it: one drawn control,
 * one focus ring, and one less pill in a toolbar that had six.
 */
export function BrowserUrlField(props: BrowserUrlFieldProps): React.ReactElement {
    const density = DENSITY[props.density ?? 'toolbar'];
    const trailingAction = props.trailingAction ?? 'none';
    const inputRef = React.useRef<RNTextInput | null>(null);
    const copyFeedback = useTemporaryCopyFeedback();
    const [focused, setFocused] = React.useState(false);
    const [message, setMessage] = React.useState<string | null>(null);
    const [rawDraft, setRawDraft] = React.useState(props.value);
    const [selection, setSelection] = React.useState<Readonly<{ start: number; end: number }> | undefined>(NO_SELECTION);

    // The submit-time value is read from a ref so a typed-then-submit interaction always acts on the
    // latest text even when the render that produced the handler has not flushed.
    const draftRef = React.useRef(rawDraft);
    draftRef.current = rawDraft;

    // Keep the editable draft in sync with the authoritative value while blurred so navigations
    // driven elsewhere (redirects, programmatic loads) are reflected on the next focus without
    // clobbering an in-progress edit.
    React.useEffect(() => {
        if (!focused) {
            setRawDraft(props.value);
            draftRef.current = props.value;
        }
    }, [focused, props.value]);

    const displayValue = focused || props.formatWhileBlurred !== true
        ? rawDraft
        : formatBrowserDisplayUrl(props.value);

    const handleFocus = React.useCallback(() => {
        setFocused(true);
        setRawDraft(props.value);
        draftRef.current = props.value;
        if (props.value.length > 0) {
            setSelection({ start: 0, end: props.value.length });
        }
    }, [props.value]);

    const handleBlur = React.useCallback(() => {
        setFocused(false);
        setSelection(NO_SELECTION);
    }, []);

    const handleChangeText = React.useCallback((next: string) => {
        // Once the user types, stop forcing the select-all range so the caret behaves, and drop a
        // stale failure so the field never accuses text the user has already replaced.
        setSelection(NO_SELECTION);
        setRawDraft(next);
        draftRef.current = next;
        setMessage(null);
    }, []);

    const submit = React.useCallback(() => {
        if (props.disabled) return;
        const normalized = normalizeBrowserAddressInput(draftRef.current, {
            ...(props.searchUrlTemplate ? { searchUrlTemplate: props.searchUrlTemplate } : {}),
        });
        if (!normalized.ok) {
            setMessage(messageForResult(normalized));
            return;
        }
        setMessage(null);
        if (props.clearOnSubmit) {
            setRawDraft('');
            draftRef.current = '';
        }
        props.onSubmitUrl(normalized.url);
    }, [props]);

    const handleKeyPress = React.useCallback((event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (event.nativeEvent.key !== 'Escape') {
            return;
        }
        setRawDraft(props.value);
        draftRef.current = props.value;
        setSelection(NO_SELECTION);
        setMessage(null);
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

    const fieldRowStyle = React.useMemo(() => ({
        height: density.height,
        borderRadius: density.radius,
        paddingLeft: density.paddingLeft,
        paddingRight: density.paddingRight,
        gap: density.paddingRight,
    }), [density]);

    return (
        <View style={stylesheet.root}>
            {props.label ? (
                <Text style={stylesheet.label}>{props.label}</Text>
            ) : null}
            <View
                style={[
                    stylesheet.fieldRow,
                    fieldRowStyle,
                    focused ? stylesheet.fieldRowFocused : null,
                    message ? stylesheet.fieldRowInvalid : null,
                ]}
            >
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
                    accessibilityLabel={props.accessibilityLabel ?? t('browserShell.address.label')}
                    placeholder={props.placeholder ?? t('browserShell.address.placeholder')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    inputMode="url"
                    returnKeyType="go"
                    style={stylesheet.input}
                />
                {trailingAction === 'copy' ? (
                    <IconButton
                        testID={`${props.testID}-copy`}
                        iconName="copy"
                        accessibilityLabel={t('browserShell.address.copy')}
                        tooltip={t('browserShell.address.copy')}
                        variant="plain"
                        size={density.button}
                        iconSize={density.iconSize}
                        minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                        interactiveTargetGapPx={density.paddingRight * 2}
                        disabled={!props.value || props.disabled}
                        onPress={handleCopyUrl}
                    />
                ) : null}
                {trailingAction === 'go' ? (
                    <IconButton
                        testID={`${props.testID}-open`}
                        iconName="arrow-right"
                        accessibilityLabel={t('browserLaunchpad.urlEntry.open')}
                        tooltip={t('browserLaunchpad.urlEntry.open')}
                        tone="primary"
                        size={density.button}
                        iconSize={density.iconSize}
                        minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                        interactiveTargetGapPx={density.paddingRight * 2}
                        disabled={props.disabled}
                        onPress={submit}
                    />
                ) : null}
                <CopiedPill
                    visible={copyFeedback.isCopied('url')}
                    testID={`${props.testID}-copy-feedback`}
                    style={stylesheet.copiedPill}
                />
            </View>
            {message ? (
                <Text
                    testID={`${props.testID}-invalid`}
                    accessibilityLiveRegion="polite"
                    role="status"
                    aria-live="polite"
                    style={stylesheet.message}
                >
                    {message}
                </Text>
            ) : null}
        </View>
    );
}
