import { ReactNode, ComponentType } from 'react';
import type { ModalCardDimensionOptions } from './components/card/useModalCardDimensions';

export type ModalType = 'alert' | 'confirm' | 'prompt' | 'custom';

export interface AlertButton {
    text: string;
    onPress?: () => void;
    style?: 'default' | 'cancel' | 'destructive';
}

export interface BaseModalConfig {
    id: string;
    type: ModalType;
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

export type CustomModalChromeCardConfig = Readonly<{
    kind: 'card';
    leading?: ReactNode;
    title?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    footer?: ReactNode;
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    layout?: 'fit' | 'fill';
    dimensions?: ModalCardDimensionOptions;
}>;

export type CustomModalChromeConfig = CustomModalChromeCardConfig;

export interface CustomModalConfig<P extends CustomModalInjectedProps = any> extends BaseModalConfig {
    type: 'custom';
    component: ComponentType<P>;
    props?: Omit<P, keyof CustomModalInjectedProps>;
    /**
     * Invoked when the modal is dismissed through shared close surfaces (backdrop/escape/close button).
     *
     * Notes:
     * - This callback is not a veto; the modal will still close after this is invoked.
     * - Prefer this over threading `onRequestClose` through component props.
     */
    onRequestClose?: () => void;
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
    show<P extends CustomModalInjectedProps>(config: Omit<CustomModalConfig<P>, 'id' | 'type'>): string;
    update<P extends CustomModalInjectedProps>(
        id: string,
        props: Partial<Omit<P, keyof CustomModalInjectedProps>>,
    ): void;
    hide(id: string): void;
    hideAll(): void;
}
