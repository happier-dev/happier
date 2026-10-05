import * as React from 'react';
import { Keyboard, Platform, StyleSheet as RNStyleSheet, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue, withTiming } from 'react-native-reanimated';

import { KeyboardAwareScreen } from '@/components/ui/keyboardAvoidance/KeyboardAwareScreen';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import {
    OVERLAY_CAPSULE_BUTTON_GAP,
    OVERLAY_CAPSULE_ROW_HEIGHT,
    OverlayCapsuleButton,
} from '@/components/ui/overlays/OverlayCapsuleButton';
import { OverlayScrim } from '@/components/ui/overlays/OverlayScrim';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { SelectionList } from '@/components/ui/selectionList';
import type { SelectionListDynamicSectionCache, SelectionListFilter, SelectionListOption, SelectionListStep } from '@/components/ui/selectionList';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import {
    UNIVERSAL_SEARCH_PLANE_TOP_GAP_PX,
    resolveUniversalSearchPlaneMaxHeight,
} from './universalSearchNativeGeometry';

/**
 * The native host for universal Search: a transparent full-screen route whose results scroll above a
 * search plane seated immediately over the software keyboard.
 *
 * It owns PRESENTATION ONLY. The query, the sections, the providers and the activation targets all
 * arrive as props from the one universal Search controller, so native and web run the same catalog
 * and the same result identities. There is no native command registry and no second query state
 * here — the canonical input is `SelectionList`'s own, placed at the bottom through
 * `inputPlacement`.
 *
 * WHY A FLEX-BOTTOM `KeyboardAwareScreen` AND NOT THE COMPOSER SCAFFOLD
 *
 * `ComposerKeyboardScaffold` owns transcript height, draft retention, attachments and cockpit
 * reporting; Search needs none of that, and cloning it would fork the keyboard geometry it owns for
 * the composer. The generic keyboard-aware screen resizes the route and an ordinary bottom-anchored
 * flex column seats the plane. A sticky-footer extraction is deliberately NOT used until a real
 * device shows this drifting from the keyboard frame.
 *
 * WHICH KEYBOARD FACT THIS HOST CONSUMES
 *
 * `useKeyboardHeight` is the canonical settled-keyboard signal, resolved per platform: the native
 * sibling `hooks/ui/useKeyboardHeight.native.ts` reads `react-native-keyboard-controller`'s
 * `useKeyboardState`, and the base module is the web visual-viewport reading. This host wants only
 * the settled facts — is the keyboard up, and how much room does it leave — so it never reaches for
 * the composer scaffold's per-frame animated keyboard layout, and it does not re-derive the
 * keyboard geometry `KeyboardAwareScreen` already applies to the frame.
 *
 * WHY THE BODY DOES NOT NEED A BOTTOM INSET
 *
 * The plane is the list's own bottom-placed header, so the scrollable body already ends where the
 * controls begin. An added inset would double the gap and push the selected row out of view.
 */

export type UniversalSearchNativeHostProps = Readonly<{
    /** Sections and rows built by the universal Search controller — never by this host. */
    rootStep: SelectionListStep;
    /** Controlled query owned by the universal controller. */
    query: string;
    onChangeQuery: (next: string) => void;
    onSelect: (id: string, option: SelectionListOption) => void;
    onCommandSelect?: (id: string, option: SelectionListOption) => void;
    /** Close the route. Activation-driven navigation is the controller's business, not the host's. */
    onRequestClose: () => void;
    selectedOptionId?: string | null;
    listAccessibilityLabel?: string;
    /** The controller's scope filters (the Home chip), shown the same way as on the web palette. */
    filters?: ReadonlyArray<SelectionListFilter>;
    inputSuffix?: React.ReactNode;
    testID?: string;
    dynamicSectionCache: SelectionListDynamicSectionCache;
}>;

/**
 * How far the frosted band reaches above the plane.
 *
 * Longer than the shared default for the same reason the floating composer's is: this plane floats
 * over whatever the user was reading, not over one quiet surface, so it needs a longer run to settle
 * against busy content while leaving that content readable.
 */
const UNIVERSAL_SEARCH_SCRIM_RAMP_HEIGHT = 128;

export function UniversalSearchNativeHost(props: UniversalSearchNativeHostProps): React.ReactElement {
    const testID = props.testID ?? 'universal-search-native-host';
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();
    const reducedMotion = useReducedMotionPreference();
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    // Seeded settled under Reduced Motion: the scrim carries the entrance, and a preference that
    // removes motion must not leave the plane sitting on nothing for a frame.
    const scrimProgress = useSharedValue(reducedMotion ? 1 : 0);
    React.useEffect(() => {
        if (reducedMotion) {
            scrimProgress.value = 1;
            return;
        }
        scrimProgress.value = withTiming(1, {
            duration: motionTokens.overlay.modal.enterMs,
            easing: reanimatedMotionTokens.easing.standard,
        });
    }, [reducedMotion, scrimProgress]);

    // Closing and touch isolation are deliberately separate concerns. The request guard prevents
    // duplicate pops, while the still-mounted route keeps its full-screen backdrop armed until the
    // navigator actually unmounts it. Disarming the overlay early leaks the closing tap through to
    // the prior screen; re-arming on a timer guesses at navigation lifecycle and can issue a second
    // pop after a slow transition.
    const closeRequestedRef = React.useRef(false);
    const requestClose = React.useCallback(() => {
        if (closeRequestedRef.current) return;
        closeRequestedRef.current = true;
        props.onRequestClose();
        // AFTER the close, never before: retracting the keyboard while this route is still mounted
        // drags the plane — and the scrim's blur layers — down the keyboard's own curve, which is
        // what tore the frost into bands on the floating composer. Android's system Back already
        // retracts the keyboard before the app ever sees it, so that platform convention is
        // preserved without a competing handler here.
        Keyboard.dismiss();
    }, [props.onRequestClose]);

    const dismissKeyboard = React.useCallback(() => {
        Keyboard.dismiss();
    }, []);

    const planeMaxHeight = resolveUniversalSearchPlaneMaxHeight({
        windowHeight,
        safeAreaTop: insets.top,
        safeAreaBottom: insets.bottom,
        keyboardHeight,
        capsuleRowHeight: OVERLAY_CAPSULE_ROW_HEIGHT,
    });

    const rootPointerEvents = resolveOverlayPointerEvents('box-none');
    const passThroughPointerEvents = resolveOverlayPointerEvents('box-none');

    return (
        <View
            testID={testID}
            style={[RNStyleSheet.absoluteFill, rootPointerEvents.webStyle]}
            pointerEvents={rootPointerEvents.nativePointerEvents}
            // Keep VoiceOver/TalkBack traversal inside the presented Search
            // surface until the route is actually unmounted. This mirrors the
            // native modal host contract while preserving the visual bottom
            // placement of the SelectionList input.
            accessibilityViewIsModal
        >
            {/*
              * The backdrop is a redundant affordance beside the explicit close capsule, so it is
              * not part of the accessibility tree: a screen reader user reaches "Close" as a real
              * labelled button instead of an unlabelled full-screen target.
              */}
            <Pressable
                testID={`${testID}:backdrop`}
                accessible={false}
                importantForAccessibility="no"
                style={RNStyleSheet.absoluteFill}
                onPress={requestClose}
            />
            <KeyboardAwareScreen
                testID={`${testID}:keyboard-frame`}
                style={[styles.keyboardFrame, passThroughPointerEvents.webStyle]}
                pointerEvents={passThroughPointerEvents.nativePointerEvents}
            >
                <View
                    testID={`${testID}:plane`}
                    style={[
                        styles.plane,
                        // The keyboard's own frame already clears the home indicator while it is
                        // up; with it down the plane is seated against the screen edge and owns
                        // that inset itself.
                        {
                            paddingBottom: keyboardHeight > 0 ? 0 : insets.bottom,
                            paddingLeft: insets.left,
                            paddingRight: insets.right,
                        },
                    ]}
                >
                    <OverlayScrim
                        testID={`${testID}:scrim`}
                        progress={scrimProgress}
                        rampHeight={UNIVERSAL_SEARCH_SCRIM_RAMP_HEIGHT}
                    />
                    <View style={styles.capsuleRow}>
                        {keyboardHeight > 0 ? (
                            <OverlayCapsuleButton
                                testID={`${testID}:dismiss-keyboard`}
                                accessibilityLabel={t('common.dismissKeyboard')}
                                icon="caret-down"
                                onPress={dismissKeyboard}
                            />
                        ) : null}
                        <OverlayCapsuleButton
                            testID={`${testID}:close`}
                            accessibilityLabel={t('common.cancel')}
                            icon="x"
                            onPress={requestClose}
                        />
                    </View>
                    <SelectionList
                        testID={`${testID}:list`}
                        inputTestID={`${testID}:input`}
                        rootStep={props.rootStep}
                        inputPlacement="bottom"
                        // The user explicitly opened Search to type: the plane is laid out for the
                        // keyboard and the results region is sized around it.
                        autoFocusInputOnNative
                        inputValue={props.query}
                        onChangeInputValue={props.onChangeQuery}
                        onSelect={props.onSelect}
                        onCommandSelect={props.onCommandSelect}
                        onRequestClose={requestClose}
                        dynamicSectionCache={props.dynamicSectionCache}
                        filters={props.filters}
                        inputSuffix={<View style={{ flexDirection: 'row' }}>{props.inputSuffix}{props.query.length > 0 ? (
                            <IconButton
                                testID={`${testID}:clear`}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.clearSearch')}
                                iconName="x"
                                size={28}
                                minimumInteractiveTargetSize={minimumInteractiveTargetSize}
                                onPress={() => props.onChangeQuery('')}
                            />
                        ) : null}</View>}
                        selectedOptionId={props.selectedOptionId ?? null}
                        {...(props.listAccessibilityLabel === undefined
                            ? {}
                            : { listAccessibilityLabel: props.listAccessibilityLabel })}
                        // Results grow upward from the plane and stop at the room the keyboard
                        // leaves; the list stays the single scroll owner inside that cap.
                        maxHeight={planeMaxHeight}
                        heightBehavior="stabilizedContentHeight"
                        showsVerticalScrollIndicator
                    />
                </View>
            </KeyboardAwareScreen>
        </View>
    );
}

const styles = RNStyleSheet.create({
    keyboardFrame: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    plane: {
        paddingTop: UNIVERSAL_SEARCH_PLANE_TOP_GAP_PX,
    },
    capsuleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: OVERLAY_CAPSULE_BUTTON_GAP,
        paddingHorizontal: OVERLAY_CAPSULE_BUTTON_GAP,
        paddingBottom: OVERLAY_CAPSULE_BUTTON_GAP,
        // The scrim is an earlier sibling whose ramp reaches up over this row; without an explicit
        // stacking order the capsules paint underneath it.
        zIndex: 1,
        elevation: 1,
    },
});
