import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { Keyboard, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { OverlayScrim } from '@/components/ui/overlays/OverlayScrim';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { isNewSessionFloatingComposerPresentation } from '@/components/sessions/new/navigation/newSessionPresentation';
import {
    NEW_SESSION_CLOSE_BUTTON_GAP,
    NEW_SESSION_CLOSE_ROW_HEIGHT,
    NewSessionComposerCloseButton,
    NewSessionComposerKeyboardDismissButton,
} from '@/components/sessions/new/components/NewSessionComposerCloseButton';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { AgentInput } from '@/components/sessions/agentInput';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { t } from '@/text';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { HandleCreateSessionOptions } from '../hooks/useCreateNewSession';
import { useNewSessionAttachmentsController } from '@/components/sessions/new/attachments/useNewSessionAttachmentsController';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import {
    useNewSessionPromptValue,
    type NewSessionPromptStore,
} from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import {
    ComposerKeyboardScaffold,
    useComposerAvailablePanelHeight,
    useComposerKeyboardLayoutContext,
} from '@/components/sessions/keyboardAvoidance';

const SIMPLE_NEW_SESSION_MIN_TOP_GAP = 8;

/**
 * How far the composer card travels on entry.
 *
 * Durations and the curve come from `motionTokens.overlay.modal` — this is an ordinary overlay and
 * should settle like every other one. Only the distance is local, because distance is a property of
 * the surface rather than of the preset (the shared tokens themselves range from 8 for a popover to
 * 32 for a full slide). A bottom-anchored card wants enough travel to read as lifting into place and
 * little enough that it does not read as a sheet arriving: the preset's own 10 is invisible here,
 * and anything past ~32 reads as the sheet this replaces. The bar the composer replaces occupies
 * roughly this much of the same space, so the card reads as rising into the layer the tab bar just
 * vacated rather than sliding in from off-screen.
 */
/**
 * How far the composer's frosted band reaches above the card.
 *
 * Taller than the shared `OVERLAY_SCRIM_RAMP_HEIGHT` default: this composer floats over the session
 * list rather than over a single quiet surface, so it needs a longer run to settle against busy,
 * scrolling content. Still far short of veiling the list - keeping it readable while you type is the
 * reason this is a floating composer and not a sheet.
 */
const SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT = 128;

const SIMPLE_NEW_SESSION_ENTER_TRAVEL_PX = 32;

/** Shared modal arrival scale; the card grows into place rather than only sliding. */
const SIMPLE_NEW_SESSION_ENTER_FROM_SCALE = motionTokens.overlay.modal.fromScale;

/** A shorter drop on the way out — exits are quieter than entrances. */
const SIMPLE_NEW_SESSION_EXIT_TRAVEL_PX = 12;

/** How long the disarmed state may persist before it is assumed the pop never happened. */
const SIMPLE_NEW_SESSION_DISMISS_SAFETY_MS = 1000;

export type NewSessionSimplePanelProps = Readonly<{
    composerTopContent?: React.ReactNode;
    statusBadges?: React.ComponentProps<typeof AgentInput>['statusBadges'];
    statusTrailingActions?: React.ReactNode;
    popoverBoundaryRef: React.RefObject<View | null>;
    headerHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    newSessionTopPadding: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    shouldBottomAnchor?: boolean;
    containerStyle: ViewStyle;
    promptStore: NewSessionPromptStore;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    canCreate: boolean;
    isCreating: boolean;
    emptyAutocompleteKinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    sessionPromptInputMaxHeight?: number;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    agentType: React.ComponentProps<typeof AgentInput>['agentType'];
    agentLabel?: React.ComponentProps<typeof AgentInput>['agentLabel'];
    handleAgentClick: React.ComponentProps<typeof AgentInput>['onAgentClick'];
    agentPickerTitle?: React.ComponentProps<typeof AgentInput>['agentPickerTitle'];
    agentPickerOptions?: React.ComponentProps<typeof AgentInput>['agentPickerOptions'];
    agentPickerSelectedOptionId?: React.ComponentProps<typeof AgentInput>['agentPickerSelectedOptionId'];
    onAgentPickerSelect?: React.ComponentProps<typeof AgentInput>['onAgentPickerSelect'];
    agentPickerApplyLabel?: React.ComponentProps<typeof AgentInput>['agentPickerApplyLabel'];
    agentPickerProbe?: React.ComponentProps<typeof AgentInput>['agentPickerProbe'];
    permissionMode: React.ComponentProps<typeof AgentInput>['permissionMode'];
    handlePermissionModeChange: React.ComponentProps<typeof AgentInput>['onPermissionModeChange'];
    modelMode: React.ComponentProps<typeof AgentInput>['modelMode'];
    setModelMode: React.ComponentProps<typeof AgentInput>['onModelModeChange'];
    modelOptions: ReadonlyArray<{ value: string; label: string; description: string }>;
    modelOptionsProbe?: React.ComponentProps<typeof AgentInput>['modelOptionsOverrideProbe'];
    acpSessionModeOptions?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    acpSessionModeProbe?: React.ComponentProps<typeof AgentInput>['acpSessionModeOptionsOverrideProbe'];
    acpSessionModeId?: string | null;
    setAcpSessionModeId?: (modeId: string | null) => void;
    acpConfigOptions?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverride'];
    acpConfigOptionsProbe?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverrideProbe'];
    acpConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    setSessionConfigOptionOverride?: (configId: string, value: string) => void;
    connectionStatus: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    machineName: string | undefined;
    machinePopover?: React.ComponentProps<typeof AgentInput>['machinePopover'];
    selectedMachineId?: string | null;
    selectedMachineHomeDir?: string | null;
    selectedPath: string;
    pathPopover?: React.ComponentProps<typeof AgentInput>['pathPopover'];
    showResumePicker: boolean;
    resumeSessionId: string | null;
    resumePopover?: React.ComponentProps<typeof AgentInput>['resumePopover'];
    isResumeSupportChecking: boolean;
    useProfiles: boolean;
    selectedProfileId: string | null;
    profilePopover?: React.ComponentProps<typeof AgentInput>['profilePopover'];
    targetServerId?: string | null;
    attachmentFlowId?: string | null;
    resumePersistedLaunchKey?: string | null;
}>;

/**
 * The capsule row above the floating composer card.
 *
 * Its own component because the keyboard subscription has to run INSIDE the scaffold's layout
 * provider; read from the panel body it would resolve to a null context and the dismiss control
 * would never appear.
 */
const NewSessionFloatingComposerCapsuleRow = React.memo(
    function NewSessionFloatingComposerCapsuleRow(
        props: Readonly<{
            onClose: () => void;
            onDismissKeyboard: () => void;
            sidePadding: number;
        }>,
    ): React.ReactElement {
        const layout = useComposerKeyboardLayoutContext();
        const [isKeyboardOpen, setIsKeyboardOpen] = React.useState(false);

        React.useEffect(() => {
            const subscribe = layout?.subscribeKeyboardHeight;
            if (!subscribe) return undefined;
            // Height rather than a focus flag: focus is claimed before the keyboard is up and held
            // after it starts leaving, which would flash the control at both ends of the curve.
            return subscribe((height) => {
                setIsKeyboardOpen(height > 0);
            });
        }, [layout]);

        return (
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: NEW_SESSION_CLOSE_BUTTON_GAP,
                    paddingHorizontal: props.sidePadding,
                    paddingBottom: NEW_SESSION_CLOSE_BUTTON_GAP,
                    // The scrim is a later sibling and its ramp reaches up over this row, so without
                    // an explicit stacking order the capsules paint underneath it and disappear.
                    zIndex: 1,
                    elevation: 1,
                }}
            >
                {isKeyboardOpen ? (
                    <NewSessionComposerKeyboardDismissButton onPress={props.onDismissKeyboard} />
                ) : null}
                <NewSessionComposerCloseButton onPress={props.onClose} />
            </View>
        );
    },
);

export const NewSessionSimplePanel = React.memo(function NewSessionSimplePanel(props: NewSessionSimplePanelProps): React.ReactElement {
    const { width: windowWidth } = useWindowDimensions();
    const shouldBottomAnchor =
        props.shouldBottomAnchor ?? (Platform.OS !== 'web' || isMobileLayoutWidth(windowWidth));
    const minimumTopGap = shouldBottomAnchor ? Math.min(props.newSessionTopPadding, SIMPLE_NEW_SESSION_MIN_TOP_GAP) : 0;

    // On native this screen is presented as a transparent modal, so it owns its own ground, its own
    // entrance and its own dismissal. On web Expo Router's drawer still owns all three.
    const isFloatingComposer = isNewSessionFloatingComposerPresentation({
        variant: 'simple',
        platformOs: Platform.OS,
    });
    const router = useRouter();
    const navigation = useNavigation();
    const reducedMotion = useReducedMotionPreference();
    // Seeded settled for the non-floating case so the sheet path renders exactly as it did before.
    const enterProgress = useSharedValue(isFloatingComposer ? 0 : 1);
    const hasStartedEntranceRef = React.useRef(false);
    // Guards against a second dismiss landing while the first is still running.
    const isDismissingRef = React.useRef(false);
    const cardExitProgress = useSharedValue(1);

    // Self-heal: a dismissal that does not actually unmount this screen would otherwise leave the
    // re-entrancy guard latched, so no later tap could dismiss it. The timer is cleared on unmount,
    // so it only ever fires when the pop did not happen.
    const dismissSafetyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => {
        if (dismissSafetyTimerRef.current !== null) clearTimeout(dismissSafetyTimerRef.current);
    }, []);

    // Started from the composer's FIRST LAYOUT, not from an effect. A mount-time effect fires while
    // this screen is still doing its (substantial) mount work and before the modal is presented, so
    // a fixed-duration animation was already finished by the time anything was on screen. Layout is
    // the earliest point at which the view provably exists with geometry.
    //
    // The card's RISE carries opacity for the scrim only, never for the card: if this somehow never
    // runs, the card is simply already in place rather than invisible — the blank-composer hazard
    // `ComposerKeyboardScaffold` warns about.
    const handleComposerEntranceLayout = React.useCallback(() => {
        if (!isFloatingComposer || hasStartedEntranceRef.current) return;
        hasStartedEntranceRef.current = true;
        if (reducedMotion) {
            enterProgress.value = 1;
            return;
        }
        // One frame after layout, not on the layout callback itself. Layout runs BEFORE
        // react-native-screens presents the modal — it defers the present to the next main-queue
        // turn precisely so children are laid out first — so starting here spent the opening frames
        // off screen and only the tail of the curve was ever visible.
        requestAnimationFrame(() => {
            enterProgress.value = withTiming(1, {
                duration: motionTokens.overlay.popover.enterMs,
                easing: reanimatedMotionTokens.easing.standard,
            });
        });
    }, [enterProgress, isFloatingComposer, reducedMotion]);

    const handleDismissKeyboard = React.useCallback(() => {
        Keyboard.dismiss();
    }, []);

    // Dismissal is deliberately NOT `Keyboard.dismiss()` + a fade. Dismissing the keyboard here
    // retracts it over its own ~250ms, and the keyboard seat drags the whole composer — including
    // the scrim — down with it. Translating three stacked masked blur layers forces an offscreen
    // re-composite every frame, and that is what tore the frost into horizontal bands on the way
    // out. The keyboard goes down anyway when the input unmounts, so there is nothing to gain by
    // starting it early.
    const handleDismissScreen = React.useCallback(() => {
        if (isDismissingRef.current) return;
        isDismissingRef.current = true;
        dismissSafetyTimerRef.current = setTimeout(() => {
            dismissSafetyTimerRef.current = null;
            isDismissingRef.current = false;
            cardExitProgress.value = 1;
        }, SIMPLE_NEW_SESSION_DISMISS_SAFETY_MS);

        const leave = () => {
            // `navigation` matters: without it `safeRouterBack` cannot use `navigation.goBack()` and
            // falls through to `router.back()`, which does not reliably settle a modal-stack
            // dismissal. The header close button this replaced always passed it, and dropping it is
            // what left `/new` lingering in the navigation state — so the next `push('/new')` was
            // deduped against a route that had not finished leaving, and the press did nothing.
            safeRouterBack({ router, navigation, fallbackHref: '/' });
            // AFTER the pop, never before: retracting the keyboard while this screen is still
            // mounted drags the composer — and the scrim's blur layers — down its curve.
            Keyboard.dismiss();
        };
        if (reducedMotion) {
            leave();
            return;
        }
        // Only the CARD animates out; the scrim is left where it is. Animating opacity on an
        // ancestor of the blur stack has the same offscreen-composite cost as moving it.
        cardExitProgress.value = withTiming(0, {
            duration: motionTokens.overlay.popover.exitMs,
            easing: reanimatedMotionTokens.easing.standard,
        }, (finished) => {
            if (finished) runOnJS(leave)();
        });
    }, [cardExitProgress, navigation, reducedMotion, router]);

    // Rise plus a touch of scale. Travel alone reads as a panel being repositioned; the small scale
    // is what makes it read as a surface arriving. `fromScale` is the shared modal token rather than
    // a number invented here.
    const composerEnterStyle = useAnimatedStyle(() => {
        const settled = enterProgress.value;
        return {
            opacity: cardExitProgress.value,
            transform: [
                {
                    translateY: (1 - settled) * SIMPLE_NEW_SESSION_ENTER_TRAVEL_PX
                        + (1 - cardExitProgress.value) * SIMPLE_NEW_SESSION_EXIT_TRAVEL_PX,
                },
                { scale: SIMPLE_NEW_SESSION_ENTER_FROM_SCALE + (1 - SIMPLE_NEW_SESSION_ENTER_FROM_SCALE) * settled },
            ],
        };
    }, [cardExitProgress, enterProgress]);

    const attachmentsController = useNewSessionAttachmentsController({
        flowId: props.attachmentFlowId,
        isCreating: props.isCreating,
        promptStore: props.promptStore,
        handleCreateSession: props.handleCreateSession,
        selectedProfileId: props.selectedProfileId,
        targetServerId: props.targetServerId,
        selectedMachineId: props.selectedMachineId,
        selectedMachineHomeDir: props.selectedMachineHomeDir,
        selectedPath: props.selectedPath,
        baseActionChips: props.agentInputExtraActionChips,
        resumePersistedLaunchKey: props.resumePersistedLaunchKey,
    });

    return (
        <ComposerKeyboardScaffold
            testID="new-session-keyboard-host"
            mode="newSession"
            contentTestID="new-session-keyboard-content"
            composerTestID="new-session-composer-keyboard-host"
            // `useHeaderHeight()` is a platform constant, not a measurement, so it still reports a
            // header this presentation does not draw. Left as-is it subtracts ~44pt of phantom
            // chrome from the composer's first-frame panel height (the scaffold substitutes its
            // measured height afterwards, so the error is one frame — which is exactly the frame
            // the panel is sized from on open).
            // `useHeaderHeight()` is a platform constant, not a measurement, so it still reports a
            // header this presentation does not draw. Forwarding it would subtract phantom chrome
            // from the keyboard layout's bootstrap viewport. The top reservation this presentation
            // DOES need travels through `availablePanelMaxHeight` instead, because `headerHeight`
            // is dropped to zero as soon as the scaffold reports a measured height.
            headerHeight={isFloatingComposer ? 0 : props.headerHeight}
            safeAreaTop={props.safeAreaTop}
            // The scaffold resolves the composer's resting offset as max(keyboardHeight,
            // safeAreaBottom). A floating card is not seated against the screen edge, so the
            // home-indicator inset is the wrong resting gap — it leaves the card sitting visibly
            // higher than its own side margin.
            //
            // The target is a TOTAL resting gap equal to the side margin, and the composer wrapper
            // already contributes `newSessionBottomPadding` below the card. Only the remainder
            // belongs here, or the two stack and the card floats too high again. The wrapper's
            // share is also what holds the card off the keyboard once it is up, so it stays put:
            // the keyboard is always taller than this remainder, and max() then ignores it.
            safeAreaBottom={isFloatingComposer
                ? Math.max(0, props.newSessionSidePadding - props.newSessionBottomPadding)
                : props.safeAreaBottom}
            style={[
                props.containerStyle,
                ...(shouldBottomAnchor
                    ? [
                        {
                            justifyContent: 'flex-end' as const,
                            paddingTop: 0,
                        },
                    ]
                    : [
                        {
                            justifyContent: 'flex-start' as const,
                            paddingTop: 0,
                        },
                    ]),
            ]}
            contentStyle={
                shouldBottomAnchor
                    ? undefined
                    : {
                        flexBasis: 0,
                        flexGrow: 0,
                    }
            }
            surface={isFloatingComposer ? 'transparent' : undefined}
            composer={(
                <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                    <Animated.View
                        onLayout={isFloatingComposer ? handleComposerEntranceLayout : undefined}
                        style={[
                            {
                                width: '100%',
                                alignSelf: 'center',
                            },
                            // The entrance lives on this view, NOT on the scaffold's composer
                            // wrapper: that wrapper carries the keyboard seat (translateY =
                            // -bottomInset, written by the keyboard worklets), and the two
                            // transforms must compose rather than compete for one style.
                            isFloatingComposer ? composerEnterStyle : null,
                        ]}
                    >
                        {isFloatingComposer ? (
                            <NewSessionFloatingComposerCapsuleRow
                                sidePadding={props.newSessionSidePadding}
                                onClose={handleDismissScreen}
                                onDismissKeyboard={handleDismissKeyboard}
                            />
                        ) : null}
                        {/*
                          * The scrim is anchored to the CARD, not to the slot. Anchoring it to the
                          * slot measured its ramp from the top of the close capsule, which put the
                          * band a capsule-plus-gap higher than the edge it is supposed to seat.
                          */}
                        <View>
                            {isFloatingComposer ? (
                                <OverlayScrim
                                    progress={enterProgress}
                                    rampHeight={SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT}
                                    testID="new-session-scrim"
                                />
                            ) : null}
                            <NewSessionSimplePanelComposer
                                panelProps={props}
                                attachmentsController={attachmentsController}
                            />
                        </View>
                    </Animated.View>
                </PopoverBoundaryProvider>
            )}
        >
            <View
                ref={props.popoverBoundaryRef}
                style={{
                    flex: 1,
                    width: '100%',
                    justifyContent: shouldBottomAnchor ? 'flex-end' : 'flex-start',
                }}
            >
                {shouldBottomAnchor ? (
                    // In the floating presentation this region IS the visible backdrop, so tapping
                    // it closes the composer — the modal contract, and the only dismiss target on
                    // Android, where a transparent presentation catches nothing by default. The
                    // draft survives: losing focus flushes any pending persist.
                    <Pressable
                        accessible={false}
                        style={{ flex: 1, width: '100%', minHeight: minimumTopGap }}
                        onPress={isFloatingComposer ? handleDismissScreen : handleDismissKeyboard}
                    />
                ) : null}
            </View>
        </ComposerKeyboardScaffold>
    );
});

type NewSessionSimplePanelComposerProps = Readonly<{
    panelProps: NewSessionSimplePanelProps;
    attachmentsController: ReturnType<typeof useNewSessionAttachmentsController>;
}>;

function NewSessionSimplePanelComposer({
    panelProps: props,
    attachmentsController,
}: NewSessionSimplePanelComposerProps): React.ReactElement {
    // The composer scaffold computes the available panel height synchronously at mount
    // (seeded from the viewport + safe-area insets), so the bottom-anchored panel can
    // size from the settled value on its first frame.
    const availablePanelHeight = useComposerAvailablePanelHeight();
    const isFloatingComposer = isNewSessionFloatingComposerPresentation({
        variant: 'simple',
        platformOs: Platform.OS,
    });
    // The owner computes the region between the composer's anchored edge and the keyboard. It
    // cannot know what THIS host draws inside that region: a close capsule row above the card, and
    // a presentation that runs under the status bar rather than below a header. Both come off the
    // budget here, or a long draft grows up through the status bar and carries the capsule — the
    // only visible way out — off screen. `headerHeight` cannot carry this: the owner drops it to
    // zero once the scaffold reports a measured height.
    const maxPanelHeight = React.useMemo(() => {
        if (!isFloatingComposer || typeof availablePanelHeight !== 'number') return availablePanelHeight;
        return Math.max(0, availablePanelHeight - props.safeAreaTop - NEW_SESSION_CLOSE_ROW_HEIGHT);
    }, [availablePanelHeight, isFloatingComposer, props.safeAreaTop]);
    // RENDER CHURN: the composer input is the only thing that re-renders per keystroke.
    // Everything above it (panel, keyboard scaffold, screen model) stays put.
    const sessionPrompt = useNewSessionPromptValue(props.promptStore);

    return (
        <View
            style={{
                paddingBottom: props.newSessionBottomPadding,
            }}
        >
            <View
                style={{ paddingHorizontal: props.newSessionSidePadding, width: '100%', alignSelf: 'stretch' }}
            >
                <View
                    style={{ width: '100%', alignSelf: 'center' }}
                >
                    {props.composerTopContent}
                    <AgentInput
                        value={sessionPrompt}
                        onChangeText={props.setSessionPrompt}
                        onSend={attachmentsController.handleSend}
                        isSendDisabled={!props.canCreate}
                        isSending={props.isCreating}
                        placeholder={t('session.inputPlaceholder')}
                        autocompleteKinds={props.emptyAutocompleteKinds}
                        autocompleteSuggestions={props.emptyAutocompleteSuggestions}
                        extraActionChips={attachmentsController.extraActionChips}
                        inputMaxHeight={props.sessionPromptInputMaxHeight}
                        maxPanelHeight={maxPanelHeight}
                        panelMaxHeightMode="host-constrained"
                        submitAccessibilityLabel={props.submitAccessibilityLabel}
                        agentType={props.agentType}
                        agentLabel={props.agentLabel}
                        onAgentClick={props.handleAgentClick}
                        agentPickerOptions={props.agentPickerOptions}
                        agentPickerSelectedOptionId={props.agentPickerSelectedOptionId}
                        onAgentPickerSelect={props.onAgentPickerSelect}
                        agentPickerApplyLabel={props.agentPickerApplyLabel}
                        agentPickerProbe={props.agentPickerProbe}
                        attachments={attachmentsController.agentInputAttachments}
                        onAttachmentsAdded={attachmentsController.attachmentsUploadsEnabled ? attachmentsController.addWebFiles : undefined}
                        hasSendableAttachments={attachmentsController.hasSendableAttachments}
                        permissionMode={props.permissionMode}
                        onPermissionModeChange={props.handlePermissionModeChange}
                        modelMode={props.modelMode}
                        onModelModeChange={props.setModelMode}
                        modelOptionsOverride={props.modelOptions}
                        modelOptionsOverrideProbe={props.modelOptionsProbe}
                        acpSessionModeOptionsOverride={props.acpSessionModeOptions}
                        acpSessionModeSelectedIdOverride={props.acpSessionModeId ?? null}
                        acpSessionModeOptionsOverrideProbe={props.acpSessionModeProbe}
                        onAcpSessionModeChange={
                            (props.acpSessionModeOptions?.length ?? 0) > 0 && props.setAcpSessionModeId
                                ? (modeId) => props.setAcpSessionModeId?.(modeId === 'default' ? null : modeId)
                                : undefined
                        }
                        acpConfigOptionsOverride={props.acpConfigOptions}
                        acpConfigOptionsOverrideProbe={props.acpConfigOptionsProbe}
                        acpConfigOptionOverridesOverride={props.acpConfigOptionOverrides ?? null}
                        onSessionConfigOptionChange={props.setSessionConfigOptionOverride}
                        connectionStatus={props.connectionStatus}
                        statusBadges={props.statusBadges}
                        statusTrailingActions={props.statusTrailingActions}
                        showStatusPermissionMode={false}
                        machineName={props.machineName}
                        machinePopover={props.machinePopover}
                        onMachineClick={undefined}
                        currentPath={props.selectedPath}
                        onPathClick={undefined}
                        pathPopover={props.pathPopover}
                        resumeSessionId={props.showResumePicker ? props.resumeSessionId : undefined}
                        onResumeClick={undefined}
                        resumePopover={props.showResumePicker ? props.resumePopover : undefined}
                        resumeIsChecking={props.isResumeSupportChecking}
                        contentPaddingHorizontal={0}
                        maxWidthCap={null}
                        {...(props.useProfiles
                            ? {
                                profileId: props.selectedProfileId,
                                profilePopover: props.profilePopover,
                                onProfileClick: undefined,
                                envVarsCount: undefined,
                                envVarsPopover: undefined,
                                onEnvVarsClick: undefined,
                            }
                            : {})}
                    />
                    {attachmentsController.attachmentsUploadsEnabled ? (
                        <AttachmentFilePicker
                            ref={attachmentsController.filePickerRef}
                            onAttachmentsPicked={attachmentsController.addPickedAttachments}
                            multiple
                        />
                    ) : null}
                </View>
            </View>
        </View>
    );
}
