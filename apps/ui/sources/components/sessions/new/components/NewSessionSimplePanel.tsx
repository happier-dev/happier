import * as React from 'react';
import type { NewSessionLaunchApprovalNoticeState } from '@/components/sessions/new/components/NewSessionLaunchApprovalNotice';
import type { ViewStyle } from 'react-native';
import { Keyboard, Platform, Pressable, StyleSheet as RNStyleSheet, View, useWindowDimensions } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import Animated, { type SharedValue } from 'react-native-reanimated';
import { OVERLAY_SCRIM_BOTTOM_EXTENSION } from '@/components/ui/overlays/OverlayScrim';
import { ScrimBand } from '@/components/ui/overlays/ScrimBand';
import {
    createFloatingBackdropPictureWebStyle,
    createModalScrimWebStyle,
} from '@/components/ui/overlays/createBackdropLayerStyle';
import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { useFloatingBackdropPicture } from '@/components/atmosphere/atmosphereBackdrop';
import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { useSetting } from '@/sync/domains/state/storage';
import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } from '@/keyboard/escape';
import { useUnistyles } from 'react-native-unistyles';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useFloatingComposerEntrance } from './useFloatingComposerEntrance';
import { useNewSessionFloatingComposer } from '@/components/sessions/new/navigation/useNewSessionFloatingComposer';
import {
    NEW_SESSION_CLOSE_ROW_HEIGHT,
    NewSessionComposerCloseButton,
    NewSessionComposerKeyboardDismissButton,
} from '@/components/sessions/new/components/NewSessionComposerCloseButton';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { blurActiveElementOnWeb } from '@/utils/platform/deferOnWeb';
import { AgentInput } from '@/components/sessions/agentInput';
import type { OrganizationPolicyLock } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import type { AgentInputExtraActionPresentation } from '@/components/sessions/agentInput/agentInputContracts';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import type { AcpConfigOptionOverridesV1} from '@happier-dev/protocol/sessions/metadata/overrides';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { HandleCreateSessionOptions } from '../hooks/useCreateNewSession';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { layout } from '@/components/ui/layout/layout';
import {
    ComposerKeyboardScaffold,
    useComposerKeyboardLayoutContext,
} from '@/components/sessions/keyboardAvoidance';
import {
    NewSessionLaunchPendingPreview,
} from '@/components/sessions/new/components/NewSessionLaunchPendingPreview';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import type { NewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import type { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { NewSessionManagedMachineDraftModel } from '../hooks/newSessionScreenModelTypes';

const SIMPLE_NEW_SESSION_MIN_TOP_GAP = 8;

/**
 * How far the composer's frosted band reaches above the card.
 *
 * Taller than the shared `OVERLAY_SCRIM_RAMP_HEIGHT` default: this composer floats over the session
 * list rather than over a single quiet surface, so it needs a longer run to settle against busy,
 * scrolling content. Still far short of veiling the list - keeping it readable while you type is the
 * reason this is a floating composer and not a sheet.
 */
export const SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT = 128;

export type NewSessionSimplePanelProps = Readonly<{
    popoverBoundaryRef: React.RefObject<View>;
    headerHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    newSessionTopPadding: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    shouldBottomAnchor?: boolean;
    containerStyle: ViewStyle;
    promptStore: NewSessionPromptStore;
    composerDocument?: NewSessionComposerDocument;
    composerReferenceHost?: React.ComponentProps<typeof AgentInput>['composerReferenceHost'];
    composerFileScope?: React.ComponentProps<typeof AgentInput>['composerFileScope'];
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    newSessionAfterSendMode?: React.ComponentProps<typeof AgentInput>['newSessionAfterSendMode'];
    /**
     * Registers this panel's Send as the one submission owner a Temporary
     * computer replacement uses. Returns its own unregistration.
     */
    registerTemporaryComputerReplacementLaunch?: (send: () => void) => () => void;
    canCreate: boolean;
    isCreating: boolean;
    pendingLaunchAttempt?: NewSessionLaunchAttempt | null;
    /**
     * Whether the compact pending card is the active launch presentation,
     * resolved once by `resolveNewSessionLaunchPresentation`. This layout places
     * the card; it never re-decides, which is how a Temporary-computer request
     * used to end up with a pending card behind its own blocking surface.
     */
    launchPendingPreviewVisible?: boolean;
    providerLaunchError?: ProviderErrorV1 | null;
    retryProviderLaunch?: () => void;
    launchApproval?: NewSessionLaunchApprovalNoticeState | null;
    /** Canonical selected Team/account disclosure for the existing Send/Run inline review. */
    creationReviewSummary?: string | null;
    /** The requester's own folders on someone else's machine (MEMBER-WORKSPACE): read state and its hint. */
    requesterIsolation?: ReturnType<typeof import('@/hooks/machine/useMachineOwnIsolationStatus').useMachineOwnIsolationStatus>;
    emptyAutocompleteKinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    sessionPromptInputMaxHeight?: number;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    /** Removable "continue from this Session" chip and its attachment row. */
    sourceContextPresentation?: AgentInputExtraActionPresentation | null;
    agentType: React.ComponentProps<typeof AgentInput>['agentType'];
    agentLabel?: React.ComponentProps<typeof AgentInput>['agentLabel'];
    handleAgentClick: React.ComponentProps<typeof AgentInput>['onAgentClick'];
    agentPickerTitle?: React.ComponentProps<typeof AgentInput>['agentPickerTitle'];
    agentPickerOptions?: React.ComponentProps<typeof AgentInput>['agentPickerOptions'];
    agentPickerSelectedOptionId?: React.ComponentProps<typeof AgentInput>['agentPickerSelectedOptionId'];
    onAgentPickerSelect?: React.ComponentProps<typeof AgentInput>['onAgentPickerSelect'];
    agentPickerApplyLabel?: React.ComponentProps<typeof AgentInput>['agentPickerApplyLabel'];
    agentPickerProbe?: React.ComponentProps<typeof AgentInput>['agentPickerProbe'];
    onAgentPickerVisibilityChange?: React.ComponentProps<typeof AgentInput>['onAgentPickerVisibilityChange'];
    permissionMode: React.ComponentProps<typeof AgentInput>['permissionMode'];
    permissionModeLock?: OrganizationPolicyLock | null;
    allowedPermissionModes?: React.ComponentProps<typeof AgentInput>['allowedPermissionModes'];
    handlePermissionModeChange: React.ComponentProps<typeof AgentInput>['onPermissionModeChange'];
    modelMode: React.ComponentProps<typeof AgentInput>['modelMode'];
    setModelMode: React.ComponentProps<typeof AgentInput>['onModelModeChange'];
    modelOptions: ReadonlyArray<{ value: string; label: string; description: string }>;
    modelOptionsProbe?: React.ComponentProps<typeof AgentInput>['modelOptionsOverrideProbe'];
    /** Full-ref inputs for the canonical model picker in a host-bound creation surface. */
    modelPickerProps?: React.ComponentProps<typeof SessionModelPicker>;
    modelPickerPresentation?: React.ComponentProps<typeof AgentInput>['modelPickerPresentation'];
    modelContentOverride?: React.ComponentProps<typeof AgentInput>['modelContentOverride'];
    acpSessionModeOptions?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    acpSessionModeProbe?: React.ComponentProps<typeof AgentInput>['acpSessionModeOptionsOverrideProbe'];
    acpSessionModeId?: string | null;
    setAcpSessionModeId?: (modeId: string | null) => void;
    acpConfigOptions?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverride'];
    acpModelConfigOptionId?: React.ComponentProps<typeof AgentInput>['acpModelConfigOptionIdOverride'];
    acpConfigOptionsProbe?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverrideProbe'];
    acpConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    setAcpConfigOptionOverride?: (configId: string, value: string) => void;
    connectionStatus: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    statusBadges?: React.ComponentProps<typeof AgentInput>['statusBadges'];
    composerTopContent?: React.ReactNode;
    /** What the empty composer asks for; defaults to the ordinary session prompt. */
    inputPlaceholder?: string;
    /** Below the composer card (a seeded draft's provenance footnote). */
    composerBottomContent?: React.ReactNode;
    statusTrailingActions?: React.ComponentProps<typeof AgentInput>['statusTrailingActions'];
    /** `null`: the Home has no machine yet, and the chip asks where to run ("Run on…"). */
    machineName: string | null | undefined;
    machinePopover?: React.ComponentProps<typeof AgentInput>['machinePopover'];
    selectedPath: string;
    pathPopover?: React.ComponentProps<typeof AgentInput>['pathPopover'];
    /** The one folder chip's state (folder, no folder, loading, machine unavailable). */
    folderChipState?: React.ComponentProps<typeof AgentInput>['folderChipState'];
    onRemoveFolder?: () => void;
    showResumePicker: boolean;
    resumeSessionId: string | null;
    resumePopover?: React.ComponentProps<typeof AgentInput>['resumePopover'];
    isResumeSupportChecking: boolean;
    useProfiles: boolean;
    selectedProfileId: string | null;
    selectedMachineId?: string | null;
    /** New's Workflow continuation consumes the same reviewed managed creation draft. */
    managedMachineDraft?: NewSessionManagedMachineDraftModel;
    isTemporaryComputer?: boolean;
    selectedMachineHomeDir?: string | null;
    profilePopover?: React.ComponentProps<typeof AgentInput>['profilePopover'];
    targetServerId?: string | null;
    attachmentFlowId?: string | null;
}>;

/**
 * The bottom-anchored floating composer's own actions at the end of its status row: retract the
 * keyboard while it is up, and leave. The row is the card's header on the band's solid ground, so they
 * are its quiet icons (as on Docked) and read with the status line and draft actions as one cluster.
 *
 * Its own component because the keyboard subscription has to run INSIDE the scaffold's layout
 * provider; read from the panel body it would resolve to a null context and the dismiss control
 * would never appear.
 */
const NewSessionFloatingComposerCapsules = React.memo(
    function NewSessionFloatingComposerCapsules(
        props: Readonly<{
            onClose: () => void;
            onDismissKeyboard: () => void;
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

        // Unwrapped, so each icon takes the status row's one gap.
        return (
            <>
                {isKeyboardOpen ? (
                    <NewSessionComposerKeyboardDismissButton onPress={props.onDismissKeyboard} />
                ) : null}
                <NewSessionComposerCloseButton onPress={props.onClose} />
            </>
        );
    },
);

/**
 * The floating composer's ground on web: the shared modal scrim over the whole window, at the
 * floating glass frost, so the composer, its status line and its actions sit directly on the
 * frosted page with no card around them. Phone layouts use the shared short band instead. Pressing outside closes.
 *
 * Where New session shows the background, the frost also carries it softly (owner, 2026-10-29): the
 * picture its atmosphere frame already holds (its thumbnail when it has one), or a planet-colour glow when
 * the planet is the source. Solid glass and Reduce Transparency keep the plain scrim.
 */
function NewSessionWebFloatingBackdrop(props: Readonly<{ onPress: (() => void) | undefined }>): React.ReactElement {
    const { theme } = useUnistyles();
    const { blurEnabled } = useGlassBlurSetting();
    const strength = useSetting('newSessionBackdropStrengthV1');
    const backdrop = useAtmosphereBandBoundary()?.backdrop ?? null;
    const scrimStyle = createModalScrimWebStyle({
        overlay: theme.colors.overlay as unknown as { scrim: string; scrimWizard?: string; scrimStrong?: string },
        enableBlur: blurEnabled,
        frost: 'floating',
        strength,
    }) as unknown as ViewStyle;
    const picture = useFloatingBackdropPicture(backdrop);
    return (
        <Pressable
            testID="new-session-scrim"
            accessible={false}
            onPress={props.onPress}
            style={[RNStyleSheet.absoluteFill, scrimStyle]}
        >
            {picture ? (
                <View
                    testID="new-session-scrim-picture"
                    pointerEvents="none"
                    style={createFloatingBackdropPictureWebStyle(picture, strength) as unknown as ViewStyle}
                />
            ) : null}
        </Pressable>
    );
}

/** The frame already owns the picture; phone Modal and Docked consume one band on every platform. */
function NewSessionFloatingBand(props: Readonly<{ progress: SharedValue<number>; sidePadding: number; bottomReach: number }>) {
    const strength = useSetting('newSessionBackdropStrengthV1');
    const picture = useFloatingBackdropPicture(useAtmosphereBandBoundary()?.backdrop ?? null);
    return <ScrimBand shown progress={props.progress} strength={strength} picture={picture}
        rampHeight={SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT} axes="top"
        reach={{ right: props.sidePadding, bottom: props.bottomReach }} testID="new-session-scrim" />;
}

export function NewSessionSimplePanel(props: NewSessionSimplePanelProps): React.ReactElement {
    const { width: windowWidth } = useWindowDimensions();
    const shouldBottomAnchor =
        props.shouldBottomAnchor ?? (Platform.OS !== 'web' || isMobileLayoutWidth(windowWidth));
    const minimumTopGap = shouldBottomAnchor ? Math.min(props.newSessionTopPadding, SIMPLE_NEW_SESSION_MIN_TOP_GAP) : 0;

    // This screen is presented as a transparent modal, so it owns its own ground, its own entrance
    // and its own dismissal (web included, owner 2026-10-18).
    const prefersFloatingComposer = useNewSessionFloatingComposer();
    const [workflowSelected, setWorkflowSelected] = React.useState(false);
    const isFloatingComposer = prefersFloatingComposer && !workflowSelected;
    const router = useRouter();
    const navigation = useNavigation();
    const entrance = useFloatingComposerEntrance(isFloatingComposer);
    // Guards against a second dismiss landing while the first is still running.
    const isDismissingRef = React.useRef(false);
    const [isDismissing, setIsDismissing] = React.useState(false);

    const handleDismissKeyboard = React.useCallback(() => {
        blurActiveElementOnWeb();
        Keyboard.dismiss();
    }, []);

    // Dismissal is deliberately NOT `Keyboard.dismiss()` + a fade. Dismissing the keyboard here
    // retracts it over its own ~250ms, and the keyboard seat drags the whole composer — including
    // the scrim — down with it. Translating three stacked masked blur layers forces an offscreen
    // re-composite every frame, and that is what tore the frost into horizontal bands on the way
    // out. The keyboard goes down anyway when the input unmounts.
    const handleDismissScreen = React.useCallback(() => {
        if (isDismissingRef.current) return;
        isDismissingRef.current = true;
        setIsDismissing(true);

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
        entrance.leave(leave);
    }, [entrance.leave, navigation, router]);

    const isWebFloatingComposer = isFloatingComposer && Platform.OS === 'web';
    // Where the floating card rests above the window's foot. On web its frost covers the window, so its
    // own side margin. A native modal is presented over the app's bar and home indicator, which stay
    // visible through the band: the card clears them by the gap the Docked card keeps.
    const { theme } = useUnistyles();
    const bottomChrome = useSessionCockpitBottomChromeHeight();
    const floatingRestingGap = Platform.OS === 'web' ? props.newSessionSidePadding
        : Math.max(props.newSessionSidePadding, bottomChrome + theme.space.s8, props.safeAreaBottom + theme.space.s8);
    const floatingRestingOffset = Math.max(0, floatingRestingGap - props.newSessionBottomPadding);
    // The modal contract on a keyboard: Escape closes the floating composer (the draft is kept).
    // It is a modal layer like `BaseModal`'s; the composer's popovers and suggestions are scoped
    // under it (`EscapeLayerProvider` below), so they consume Escape first.
    const escapeLayer = useEscapeLayer({
        enabled: isFloatingComposer && !props.isCreating,
        priority: ESCAPE_LAYER_PRIORITIES.modal,
        allowEditableTarget: true,
        onEscape: () => {
            handleDismissScreen();
            return true;
        },
    });

    const composerReservedHeight = props.newSessionBottomPadding
        + (shouldBottomAnchor
            // The floating composer is bottom-anchored but still runs under the status bar and keeps
            // a capsule-high status row (leave, keyboard) above its input. Neither is subtracted
            // anywhere else, so without reserving them a long draft grows up through the status bar
            // and carries the only visible dismiss control off screen with it.
            ? (isFloatingComposer ? props.safeAreaTop + NEW_SESSION_CLOSE_ROW_HEIGHT : 0)
            : props.safeAreaTop + props.newSessionTopPadding);
    // A centred desktop composer closes from its frosted ground and Escape; its way out belongs to the
    // bottom-anchored (touch) composition, as the quiet icons of the status row the card already draws.
    const cardPanelProps = isFloatingComposer && shouldBottomAnchor
        ? {
            ...props,
            statusTrailingActions: (
                <>
                    {props.statusTrailingActions}
                    <NewSessionFloatingComposerCapsules
                        onClose={handleDismissScreen}
                        onDismissKeyboard={handleDismissKeyboard}
                    />
                </>
            ),
        }
        : props;
    const showPendingLaunchPreview = props.launchPendingPreviewVisible === true
        && props.pendingLaunchAttempt != null;
    // A bottom-anchored composer leaves the screen above it to the card; a centred desktop composer
    // has no such region (its content area is zero-height), so there the card sits in the composer
    // column, directly above the composer, and can never cover it.
    const pendingLaunchPreview = showPendingLaunchPreview ? (
        <View
            style={{
                width: '100%',
                alignSelf: 'stretch',
                paddingHorizontal: props.newSessionSidePadding,
                paddingBottom: 8,
            }}
        >
            <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                <NewSessionLaunchPendingPreview launchAttempt={props.pendingLaunchAttempt} />
            </View>
        </View>
    ) : null;
    const shellStyle = [
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
                    // A desktop floating composer sits in the middle of the frosted window, where
                    // the route card used to.
                    justifyContent: isWebFloatingComposer ? 'center' as const : 'flex-start' as const,
                    paddingTop: 0,
                },
            ]),
        // The WHOLE modal stops hit-testing the instant dismissal starts, not just the backdrop.
        // This screen is a presented view controller whose root covers the display, so every view
        // inside it claims a touch while it is still mounted, and the exit animation keeps it
        // mounted after the card has visually gone. Disarming only the backdrop left the rest of
        // that surface swallowing the first press on the tab bar underneath.
        isFloatingComposer && isDismissing ? { pointerEvents: 'none' as const } : null,
        // On web the scaffold spans the window above the frosted backdrop: only its content takes
        // presses, so a press beside the composer reaches the backdrop and closes.
        isWebFloatingComposer && !isDismissing ? { pointerEvents: 'box-none' as const } : null,
    ];
    return (
        <EscapeLayerProvider layer={escapeLayer}>
        {isWebFloatingComposer ? shouldBottomAnchor ? (
            <Pressable testID="new-session-backdrop-dismiss" accessible={false}
                onPress={props.isCreating ? undefined : handleDismissScreen} style={RNStyleSheet.absoluteFill} />
        ) : (
            <NewSessionWebFloatingBackdrop onPress={props.isCreating ? undefined : handleDismissScreen} />
        ) : null}
        <ComposerKeyboardScaffold
            testID="new-session-keyboard-host"
            mode="newSession"
            contentTestID="new-session-keyboard-content"
            composerTestID="new-session-composer-keyboard-host"
            // `useHeaderHeight()` is a platform constant, not a measurement, so it still reports a
            // header the floating presentation does not draw. Left as-is it subtracts ~44pt of
            // phantom chrome from the keyboard layout's bootstrap viewport.
            headerHeight={isFloatingComposer ? 0 : props.headerHeight}
            // The scaffold resolves the composer's resting offset as max(keyboardHeight,
            // safeAreaBottom). A floating card rests at its own gap (above). The composer wrapper
            // already pads `newSessionBottomPadding` below the card, so only the remainder belongs
            // here. With the keyboard up the card rides it at that padding, so no bar is cleared twice.
            safeAreaBottom={isFloatingComposer
                ? floatingRestingOffset
                : props.safeAreaBottom}
            style={shellStyle}
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
                        onLayout={entrance.onComposerLayout}
                        style={[
                            {
                                width: '100%',
                                alignSelf: 'center',
                            },
                            // The entrance lives on this view, NOT on the scaffold's composer
                            // wrapper: that wrapper carries the keyboard seat (translateY =
                            // -bottomInset, written by the keyboard worklets), and the two
                            // transforms must compose rather than compete for one style.
                            isFloatingComposer ? entrance.style : null,
                        ]}
                    >
                        {/*
                          * The scrim shares the card's padded wrapper.
                          * Its reach starts at that wrapper's foot, not the card's visible edge.
                          */}
                        <View>
                        {shouldBottomAnchor ? null : pendingLaunchPreview}
                        {isFloatingComposer && (!isWebFloatingComposer || shouldBottomAnchor) ? (
                            <NewSessionFloatingBand progress={entrance.enterProgress} sidePadding={props.newSessionSidePadding}
                                bottomReach={Platform.OS === 'web' ? OVERLAY_SCRIM_BOTTOM_EXTENSION : floatingRestingOffset - bottomChrome} />
                        ) : null}
                        <NewSessionComposerCard
                            panelProps={cardPanelProps}
                            layout="screen"
                            reservedHeight={composerReservedHeight}
                            onWorkflowSelectionChange={setWorkflowSelected}
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
                    // draft survives: losing focus flushes any pending persist. While a launch is
                    // in flight this region hosts the pending preview instead, and a stray tap must
                    // not throw away the feedback the user is waiting on.
                    <Pressable
                        accessible={false}
                        style={{ flex: 1, width: '100%', minHeight: minimumTopGap }}
                        onPress={isFloatingComposer && !props.isCreating ? handleDismissScreen : handleDismissKeyboard}
                    />
                ) : null}
                {shouldBottomAnchor ? pendingLaunchPreview : null}
            </View>
        </ComposerKeyboardScaffold>
        </EscapeLayerProvider>
    );
}
