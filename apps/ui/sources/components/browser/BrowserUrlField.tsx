import * as React from 'react';
import { Platform, View, type NativeSyntheticEvent, type TextInput as RNTextInput, type TextInputKeyPressEventData, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
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
 * the 44px entry on the launchpad (`toolbarPrecise` is the toolbar row under a precise pointer), where the field is the primary thing on screen and gets a real
 * touch target; `capsule` is the phone's address (H-UX §5): a full capsule that, until tapped, names
 * only the host, centred with its trust glyph — the path and the caret arrive with the tap.
 */
export type BrowserUrlFieldDensity = 'toolbar' | 'toolbarPrecise' | 'panel' | 'capsule';

/**
 * The single trailing affordance inside the field. `copy` puts the authoritative URL on the
 * clipboard (the toolbar's address bar); `go` submits (the launchpad's entry box). Both are
 * URL-field concerns, which is why they live here rather than being passed in as a slot — a slot
 * would let the two call sites drift apart again.
 */
export type BrowserUrlFieldTrailingAction = 'copy' | 'go' | 'none';

const DENSITY = {
    // The chrome's address field is a quiet filled capsule inside a quiet row (lab `browser` Q): no
    // outline of its own, so the page stays the hero. The launchpad's entry box keeps its border —
    // there the field IS the surface's one control.
    toolbar: { height: 34, radius: 8, paddingLeft: 10, paddingRight: 3, button: 28, iconSize: 15, outlined: false },
    // The same row under a precise pointer (desktop web, Tauri): the lab's 30 px field with a 24 px
    // trailing control, chosen by the chrome metric owner (`resolveBrowserChromeControlMetrics`).
    toolbarPrecise: { height: 30, radius: 9, paddingLeft: 10, paddingRight: 3, button: 24, iconSize: 14, outlined: false },
    panel: { height: 44, radius: 11, paddingLeft: 12, paddingRight: 6, button: 32, iconSize: 17, outlined: true },
    capsule: { height: 36, radius: 18, paddingLeft: 14, paddingRight: 4, button: 28, iconSize: 15, outlined: false },
} as const satisfies Record<BrowserUrlFieldDensity, Readonly<{
    height: number;
    radius: number;
    paddingLeft: number;
    paddingRight: number;
    button: number;
    iconSize: number;
    outlined: boolean;
}>>;

const NO_SELECTION = undefined;

/**
 * On the web the field's resting/focused swaps cross-fade (the capsule's centred face giving way to the
 * full address, Copy surfacing in its slot) instead of switching in one frame. Native swaps at once.
 */
const FADE_ON_WEB: (TextStyle & ViewStyle) | null = Platform.OS === 'web'
    ? {
        transitionProperty: 'opacity, color',
        transitionDuration: `${motionTokens.durationMs.fast}ms`,
        transitionTimingFunction: motionTokens.easingCss.standard,
    } as unknown as TextStyle & ViewStyle
    : null;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        minWidth: 0,
        gap: 4,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    fieldRowInvalid: {
        borderColor: theme.colors.status.error,
    },
    leading: {
        flexShrink: 0,
        marginLeft: -4,
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
        // Q2 measured the theme's semantic FOREGROUNDS as text at 2.20–3.55:1 in light theme —
        // they are fill colours, not text colours. The words carry their own meaning here, so
        // they take `text.primary`; the hue stays on the border/glyph beside them, where it is a
        // redundant cue rather than the only one.
        color: theme.colors.text.primary,
    },
    // The capsule's resting face: the host and its trust glyph, centred. Drawn over the field (which
    // keeps the focus, the label and the value for assistive technology) and never takes a touch.
    capsuleFace: {
        ...StyleSheet.absoluteFillObject,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: 14,
        pointerEvents: 'none',
    },
    capsuleHost: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    inputResting: {
        // The field's own text stays laid out (and readable to assistive technology) under the face.
        color: 'transparent',
    },
    trailingResting: {
        opacity: 0,
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
        case 'invalid_url':
            // An existing, already-translated key rather than a new one: "This address can't be
            // opened." is exactly what happened, and the corridor does not need a second string
            // that says it in different words.
            return t('browserShell.unavailable.invalidUrl');
    }
}

/** UB-6: the imperative surface the focus-address shortcut needs, and nothing more. */
export type BrowserUrlFieldHandle = Readonly<{ focus: () => void }>;

export type BrowserUrlFieldProps = Readonly<{
    testID: string;
    /**
     * UB-6: focus handle for the browser's focus-address keyboard shortcut. A plain ref object
     * rather than a `forwardRef` conversion, so this stays an ordinary component and the shortcut
     * owner gets exactly one method.
     */
    focusRef?: React.MutableRefObject<BrowserUrlFieldHandle | null>;
    /** The authoritative URL this field reflects. Empty for a new-tab entry box. */
    value: string;
    disabled?: boolean;
    density?: BrowserUrlFieldDensity;
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
    /**
     * The one mark that leads the field: the page's trust glyph (secure, local, insecure). Trust is
     * part of the address, so it sits inside it rather than in a chip beside it.
     */
    leading?: React.ReactNode;
    /** First actual change in an edit gesture, never focus or Copy. The caller owns admission. */
    onEditStart?: () => void;
    /** An owner context change starts a fresh gesture even while the field stays focused. */
    editIntentKey?: string;
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
    const densityKey = props.density ?? 'toolbar';
    const density = DENSITY[densityKey];
    const trailingAction = props.trailingAction ?? 'none';
    const inputRef = React.useRef<RNTextInput | null>(null);
    React.useImperativeHandle(props.focusRef, () => ({
        focus: () => {
            if (props.disabled) return;
            inputRef.current?.focus();
        },
    }), [props.disabled]);
    const copyFeedback = useTemporaryCopyFeedback();
    const [focused, setFocused] = React.useState(false);
    // The address bar's Copy waits in its trailing slot until the field is hovered or focused (lab
    // `browser` Q): at rest the field is only the trust glyph and the address. The slot keeps its
    // place, so nothing shifts when it appears; keyboard focus on Copy itself reveals it.
    const [hovered, setHovered] = React.useState(false);
    const [trailingFocused, setTrailingFocused] = React.useState(false);
    const [message, setMessage] = React.useState<string | null>(null);
    const [rawDraft, setRawDraft] = React.useState(props.value);
    const [selection, setSelection] = React.useState<Readonly<{ start: number; end: number }> | undefined>(NO_SELECTION);

    // The submit-time value is read from a ref so a typed-then-submit interaction always acts on the
    // latest text even when the render that produced the handler has not flushed.
    const draftRef = React.useRef(rawDraft);
    draftRef.current = rawDraft;
    const editIntent = React.useRef({ key: props.editIntentKey, started: false });

    // Keep the editable draft in sync with the authoritative value while blurred so navigations
    // driven elsewhere (redirects, programmatic loads) are reflected on the next focus without
    // clobbering an in-progress edit.
    React.useEffect(() => {
        if (!focused) {
            setRawDraft(props.value);
            draftRef.current = props.value;
        }
    }, [focused, props.value]);

    // The capsule at rest shows its face (host + trust glyph) instead of the field's own text.
    const resting = densityKey === 'capsule' && !focused && props.value.length > 0;
    const displayValue = focused || props.formatWhileBlurred !== true
        ? rawDraft
        : formatBrowserDisplayUrl(props.value, { hostOnly: densityKey === 'capsule' });

    const handleFocus = React.useCallback(() => {
        editIntent.current = { key: props.editIntentKey, started: false };
        setFocused(true);
        setRawDraft(props.value);
        draftRef.current = props.value;
        if (props.value.length > 0) {
            setSelection({ start: 0, end: props.value.length });
        }
    }, [props.value, props.editIntentKey]);

    const handleBlur = React.useCallback(() => {
        editIntent.current.started = false;
        setFocused(false);
        setSelection(NO_SELECTION);
    }, []);

    const handleChangeText = React.useCallback((next: string) => {
        if (!props.disabled && next !== draftRef.current
            && (!editIntent.current.started || editIntent.current.key !== props.editIntentKey)) {
            editIntent.current = { key: props.editIntentKey, started: true };
            props.onEditStart?.();
        }
        // Once the user types, stop forcing the select-all range so the caret behaves, and drop a
        // stale failure so the field never accuses text the user has already replaced.
        setSelection(NO_SELECTION);
        setRawDraft(next);
        draftRef.current = next;
        setMessage(null);
    }, [props.disabled, props.editIntentKey, props.onEditStart]);

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
        // `minHeight`, not `height`: Q2 measured that the app's `uiFontScale` GROWS the line box, so a
        // fixed-height field is what actually clips scaled text. The field grows with the user's
        // setting instead of cropping it.
        minHeight: density.height,
        borderRadius: density.radius,
        paddingLeft: density.paddingLeft,
        paddingRight: density.paddingRight,
        gap: density.paddingRight,
        ...(density.outlined ? {} : { borderColor: 'transparent' }),
    }), [density]);

    const copyRevealed = focused || hovered || trailingFocused || copyFeedback.isCopied('url');
    return (
        <View style={stylesheet.root}>
            <View
                testID={`${props.testID}-field-row`}
                onPointerEnter={trailingAction === 'copy' ? () => setHovered(true) : undefined}
                onPointerLeave={trailingAction === 'copy' ? () => setHovered(false) : undefined}
                style={[
                    stylesheet.fieldRow,
                    fieldRowStyle,
                    message ? stylesheet.fieldRowInvalid : null,
                ]}
            >
                {props.leading && !resting ? <View style={stylesheet.leading}>{props.leading}</View> : null}
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
                    style={[stylesheet.input, FADE_ON_WEB, resting ? stylesheet.inputResting : null]}
                />
                {resting ? (
                    <View testID={`${props.testID}-capsule-face`} style={stylesheet.capsuleFace} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        {props.leading ?? null}
                        <Text numberOfLines={1} style={stylesheet.capsuleHost}>{displayValue}</Text>
                    </View>
                ) : null}
                {trailingAction === 'copy' ? (
                    <View
                        testID={`${props.testID}-trailing`}
                        style={[FADE_ON_WEB, copyRevealed ? null : stylesheet.trailingResting]}
                        onFocus={() => setTrailingFocused(true)}
                        onBlur={() => setTrailingFocused(false)}
                    >
                        <IconButton
                            testID={`${props.testID}-copy`}
                            iconName="copy"
                            accessibilityLabel={t('browserShell.address.copy')}
                            tooltip={t('browserShell.address.copy')}
                            variant="plain"
                            size={density.button}
                            iconSize={density.iconSize}
                            minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined}
                            interactiveTargetGapPx={density.paddingRight * 2}
                            disabled={!props.value || props.disabled}
                            onPress={handleCopyUrl}
                        />
                    </View>
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
                        minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined}
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
