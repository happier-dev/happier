import type { ComponentProps } from 'react';
import { ReactNode, ComponentType } from 'react';
import type { ModalCardDimensionOptions } from './components/card/useModalCardDimensions';
import type { ModalPortalTarget } from './portal/ModalPortalTarget';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

export type ModalType = 'alert' | 'confirm' | 'prompt' | 'custom';

export interface AlertButton {
    text: string;
    onPress?: () => void;
    style?: 'default' | 'cancel' | 'destructive';
    /** A disclosure beside the decision (Technical details): drawn quieter than the choices that act. Web dialog only. */
    quiet?: boolean;
}

export type ModalCommandBridgeProps = Readonly<{
    children: ReactNode;
    modalCommands?: Readonly<{
        commands: readonly CurrentUiContextLocalCommand[];
        render: (invoke: (key: string, input?: PluginUiJsonValueV1) => unknown) => ReactNode;
    }>;
}>;

export interface BaseModalConfig {
    id: string;
    type: ModalType;
    accessibilityLabel?: string;
    webPortalTarget?: ModalPortalTarget;
    focusReturnRef?: FocusReturnRef;
    /** Captures the opener's current-context composition for opted-in modal controls and chrome. */
    commandBridge?: ComponentType<ModalCommandBridgeProps>;
    /** Web-only placement within the full-screen modal shell. */
    webPlacement?: 'auto' | 'top';
}

export interface AlertModalConfig extends BaseModalConfig {
    type: 'alert';
    title: string;
    message?: string;
    buttons?: AlertButton[];
}

export type ConfirmModalToggle = Readonly<{ label: string; description?: string }>;

export type ConfirmModalToggleDecision = Readonly<{ confirmed: boolean; checked: boolean }>;

export interface ConfirmModalConfig extends BaseModalConfig {
    type: 'confirm';
    title: string;
    message?: string;
    /** A paragraph may end with one quiet link to where its subject can be checked (a provider console). */
    messageParagraphs?: readonly Readonly<{ text: string; irreversible?: boolean; link?: Readonly<{ label: string; onPress: () => void }> }>[];
    /** What the choice changes, as label and value pairs under the message ("Frees" · "186 MB"). */
    facts?: readonly Readonly<{ label: string; value: string }>[];
    /** Optional additional consequence. Every new confirmation starts unchecked. */
    toggle?: ConfirmModalToggle;
    cancelText?: string;
    confirmText?: string;
    destructive?: boolean;
}

export interface PromptModalConfig extends BaseModalConfig {
    type: 'prompt';
    title: string;
    message?: string;
    placeholder?: string;
    defaultValue?: string;
    cancelText?: string;
    confirmText?: string;
    inputType?: 'default' | 'secure-text' | 'email-address' | 'numeric';
    /** The mounted confirm command's actor, before the prompt settles its existing string result. */
    onConfirmContext?: (context: ActionExecutorContext) => void;
    /** For a prompt that owns a write, let Confirm return that operation's settlement. */
    onAnswer?: (value: string | null, context?: ActionExecutorContext) => ReturnType<CurrentUiContextLocalCommand['invoke']>;
}

export type CustomModalInjectedProps = Readonly<{
    onClose: () => void;
    setChrome?: (chrome: CustomModalChromeConfig | null) => void;
}>;

export type CustomModalDismissReason = 'shared' | 'action';

export type CustomModalDismissGuard = (
    reason: CustomModalDismissReason,
) => boolean | void | PromiseLike<boolean | void>;

export type CustomModalComponentType<P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> =
    ComponentType<CustomModalInjectedProps & P>;

type CustomModalComponentProps<C extends ComponentType<any>> = ComponentProps<C>;

/** Preserve each caller-visible arm when a custom modal has union props. */
export type CustomModalCallerProps<P extends CustomModalInjectedProps> = P extends unknown
    ? Omit<P, keyof CustomModalInjectedProps> : never;

export type CustomModalShowConfig<C extends CustomModalComponentType<any>> = Omit<
    CustomModalConfig<CustomModalComponentProps<C>>,
    'id' | 'type' | 'component' | 'props'
> & Readonly<{
    component: C;
    props?: CustomModalCallerProps<CustomModalComponentProps<C>>;
}>;

export type CustomModalChromeCardConfig = Readonly<{
    kind: 'card';
    /**
     * Forms can request opaque paper while ordinary modal chrome retains the chosen glass material.
     * `overContent` is that glass hung without a scrim over whatever the page shows (a PDF, a picture, a
     * shared screen): it takes the live-picture coat, so a white page never washes a dark card grey.
     */
    material?: 'glass' | 'solid' | 'overContent';
    /**
     * `none` renders no title band: the content is the top of the card (search, command palette).
     * `title` stays the dialog's accessible name. Esc and the backdrop still close it.
     */
    header?: 'band' | 'none';
    /**
     * `wide`: the title band's text and close control stand on the content's own 24 edge instead of the band's
     * 16 (a dialog whose tools band and rows are inset to 24). A phone keeps the page gutter.
     */
    headerInset?: 'wide';
    leading?: ReactNode;
    /**
     * `above`: on a phone the leading slot (a way back) takes its own row with the close control and the title
     * and subtitle stand beneath it on the page gutter, instead of sharing one narrow row.
     */
    leadingPlacement?: 'above' | null;
    title?: ReactNode;
    subtitle?: ReactNode;
    /**
     * The subtitle ends in an ellipsis after this many lines: `1` for a line of facts that can be long, `2` for a
     * sentence that quotes a name the user wrote (a Session title) so a long name can't take over the card.
     */
    subtitleLines?: 1 | 2;
    actions?: ReactNode;
    footer?: ReactNode;
    /**
     * Controls which layer owns vertical overflow:
     * - `overlay`: the outer BaseModal overlay scrolls (default)
     * - `body`: the modal card is constrained to the viewport and the modal body is expected
     *   to provide its own internal scroll region when needed
     * - `bounded`: the card is as tall as its content up to the viewport bound, then the modal body
     *   scrolls inside it (header and footer stay in view); use it when the content's size varies
     */
    scrollHost?: 'overlay' | 'body' | 'bounded';
    /**
     * `bounded` only: names the screen the card shows. The card keeps its tallest height within one screen (a
     * narrowed list never shrinks under the person); a new key, such as a wizard's next step or a settled run,
     * lets it fit the new content.
     */
    screenKey?: string;
    bodyScroll?: 'none' | 'auto';
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    dimensions?: ModalCardDimensionOptions;
    /**
     * `sheet` presents the card as a bottom sheet on a phone (full width, anchored to the bottom edge,
     * thumb reach); wider screens keep the centred card. Default: the centred card everywhere.
     * `fullscreen` fills the phone viewport with opaque page chrome and safe-area-inset content.
     */
    phonePresentation?: 'card' | 'sheet' | 'fullscreen';
    /**
     * The control that opened the card. On wide layouts the same card hangs from it as an anchored
     * popover (below it, flipping or sliding to stay in the window) instead of a centred dialog; a phone
     * keeps `phonePresentation`. Without it the card stays centred.
     */
    anchor?: PopoverAnchor;
    /**
     * `picker`: a value picker hung from its field (a saved secret, a folder, a Session). It opens below the field,
     * above only when that side has more room, and takes the room there with its list scrolling inside, so it never
     * covers the field. Without it an anchored card is a designed surface that keeps its size and slides inside the
     * window, over its trigger if it must (Share, Connect).
     */
    anchorRole?: 'picker';
}>;

export type CustomModalChromeStageConfig = Readonly<{
    kind: 'stage';
    testID?: string;
    title?: string;
}>;

export type CustomModalChromeConfig = CustomModalChromeCardConfig | CustomModalChromeStageConfig;

export interface CustomModalConfig<P extends CustomModalInjectedProps = any> extends BaseModalConfig {
    type: 'custom';
    component: ComponentType<P>;
    props?: CustomModalCallerProps<P>;
    /**
     * When false, shared dismissal surfaces (backdrop, Escape/native back, and
     * card close button) are disabled. The component may still finish its
     * bounded flow through the injected `onClose`.
     */
    dismissible?: boolean;
    /**
     * Invoked when the modal is dismissed through shared close surfaces (backdrop/escape/close button).
     *
     * Notes:
     * - This callback is not a veto; the modal will still close after this is invoked.
     * - Prefer this over threading `onRequestClose` through component props.
     */
    onRequestClose?: () => void;
    /**
     * Optionally decides whether a user-requested dismissal may proceed.
     *
     * Return `false` or reject to keep the modal open. Returning `true` or
     * `void` permits the dismissal, so existing modals keep their current
     * behavior when no guard is supplied. The reason distinguishes shared
     * close surfaces from an injected content action.
     */
    onDismissRequest?: CustomModalDismissGuard;
    /**
     * Synchronously settles modal-owned work when this provider is removed.
     * It is not a user choice and must not perform the modal's destructive or
     * committing action.
     */
    onHostUnmount?: () => void;
    chrome?: CustomModalChromeConfig;
    /**
     * `sheet`: the content draws its own bottom sheet on a phone (a story deck), so the modal anchors it to the
     * bottom edge and leaves the home-indicator inset to it. Card chrome says this with `chrome.phonePresentation`.
     */
    phonePresentation?: 'sheet';
    /**
     * Whether tapping the backdrop should close the modal.
     * Defaults to true.
     */
    closeOnBackdrop?: boolean;
}

export type ModalConfig = AlertModalConfig | ConfirmModalConfig | PromptModalConfig | CustomModalConfig<any>;

/** Keep each modal's fields while the provider supplies its id. */
export type ModalShowConfig<T extends ModalConfig = ModalConfig> = T extends unknown ? Omit<T, 'id'> : never;

export interface ModalState {
    modals: ModalConfig[];
}

export interface ModalContextValue {
    /**
     * True while this provider hosts at least one modal.
     *
     * A composer scaffold OUTSIDE a modal boundary reads this to stop lifting with the keyboard:
     * while a modal is open the keyboard belongs to the modal, and a background composer sliding
     * up behind it reads as two surfaces competing for the same inset.
     */
    isKeyboardLiftSuppressedByModal: boolean;
    state: ModalState;
    showModal: (config: ModalShowConfig) => string;
    hideModal: (id: string) => void;
    hideAllModals: () => void;
    updateCustomModalProps: (id: string, props: Record<string, unknown>) => void;
}

export interface IModal {
    alert(title: string, message?: string, buttons?: AlertButton[], options?: Pick<BaseModalConfig, 'commandBridge'>): void;
    alertAsync(title: string, message?: string, buttons?: AlertButton[], options?: Pick<BaseModalConfig, 'commandBridge'>): Promise<void>;
    confirm(title: string, message?: string, options?: {
        cancelText?: string;
        confirmText?: string;
        destructive?: boolean;
        messageParagraphs?: ConfirmModalConfig['messageParagraphs'];
        facts?: ConfirmModalConfig['facts'];
        focusReturnRef?: FocusReturnRef;
        /** Dismiss when the operation that owns this decision can no longer execute. */
        signal?: AbortSignal;
        commandBridge?: BaseModalConfig['commandBridge'];
    }): Promise<boolean>;
    prompt(title: string, message?: string, options?: {
        placeholder?: string;
        defaultValue?: string;
        cancelText?: string;
        confirmText?: string;
        inputType?: 'default' | 'secure-text' | 'email-address' | 'numeric';
        commandBridge?: BaseModalConfig['commandBridge'];
        onConfirmContext?: PromptModalConfig['onConfirmContext'];
        onAnswer?: PromptModalConfig['onAnswer'];
    }): Promise<string | null>;
    show<C extends CustomModalComponentType<any>>(config: CustomModalShowConfig<C>): string;
    update<P extends CustomModalInjectedProps>(
        id: string,
        props: Partial<CustomModalCallerProps<P>>,
    ): void;
    hide(id: string): void;
    hideAll(): void;
}
