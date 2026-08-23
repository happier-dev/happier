import type { ComponentProps } from 'react';
import { ReactNode, ComponentType } from 'react';
import type { ModalCardDimensionOptions } from './components/card/useModalCardDimensions';
import type { ModalPortalTarget } from './portal/ModalPortalTarget';

export type ModalType = 'alert' | 'confirm' | 'prompt' | 'custom';

export interface AlertButton {
    text: string;
    onPress?: () => void;
    style?: 'default' | 'cancel' | 'destructive';
}

export interface BaseModalConfig {
    id: string;
    type: ModalType;
    accessibilityLabel?: string;
    webPortalTarget?: ModalPortalTarget;
}

export interface AlertModalConfig extends BaseModalConfig {
    type: 'alert';
    title: string;
    message?: string;
    buttons?: AlertButton[];
}

export interface ConfirmModalConfig extends BaseModalConfig {
    type: 'confirm';
    title: string;
    message?: string;
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

export type CustomModalShowConfig<C extends CustomModalComponentType<any>> = Omit<
    CustomModalConfig<CustomModalComponentProps<C>>,
    'id' | 'type' | 'component' | 'props'
> & Readonly<{
    component: C;
    props?: Omit<CustomModalComponentProps<C>, keyof CustomModalInjectedProps>;
}>;

export type CustomModalChromeCardConfig = Readonly<{
    kind: 'card';
    leading?: ReactNode;
    title?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    footer?: ReactNode;
    /**
     * Controls which layer owns vertical overflow:
     * - `overlay`: the outer BaseModal overlay scrolls (default)
     * - `body`: the modal card is constrained to the viewport and the modal body is expected
     *   to provide its own internal scroll region when needed
     */
    scrollHost?: 'overlay' | 'body';
    bodyScroll?: 'none' | 'auto';
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    dimensions?: ModalCardDimensionOptions;
}>;

export type CustomModalChromeConfig = CustomModalChromeCardConfig;

export interface CustomModalConfig<P extends CustomModalInjectedProps = any> extends BaseModalConfig {
    type: 'custom';
    component: ComponentType<P>;
    props?: Omit<P, keyof CustomModalInjectedProps>;
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
     * Whether tapping the backdrop should close the modal.
     * Defaults to true.
     */
    closeOnBackdrop?: boolean;
}

export type ModalConfig = AlertModalConfig | ConfirmModalConfig | PromptModalConfig | CustomModalConfig<any>;

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
    showModal: (config: Omit<ModalConfig, 'id'>) => string;
    hideModal: (id: string) => void;
    hideAllModals: () => void;
    updateCustomModalProps: (id: string, props: Record<string, unknown>) => void;
}

export interface IModal {
    alert(title: string, message?: string, buttons?: AlertButton[]): void;
    alertAsync(title: string, message?: string, buttons?: AlertButton[]): Promise<void>;
    confirm(title: string, message?: string, options?: {
        cancelText?: string;
        confirmText?: string;
        destructive?: boolean;
    }): Promise<boolean>;
    prompt(title: string, message?: string, options?: {
        placeholder?: string;
        defaultValue?: string;
        cancelText?: string;
        confirmText?: string;
        inputType?: 'default' | 'secure-text' | 'email-address' | 'numeric';
    }): Promise<string | null>;
    show<C extends CustomModalComponentType<any>>(config: CustomModalShowConfig<C>): string;
    update<P extends CustomModalInjectedProps>(
        id: string,
        props: Partial<Omit<P, keyof CustomModalInjectedProps>>,
    ): void;
    hide(id: string): void;
    hideAll(): void;
}
