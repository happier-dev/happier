import { Platform, Alert } from 'react-native';
import { t } from '@/text';
import { AlertButton, ModalConfig, CustomModalConfig, IModal, type CustomModalShowConfig, type CustomModalComponentType, type CustomModalInjectedProps } from './types';

type ModalProviderFunctions = Readonly<{
    showModal: (config: Omit<ModalConfig, 'id'>) => string;
    hideModal: (id: string) => void;
    hideAllModals: () => void;
    updateCustomModalProps: (id: string, props: Record<string, unknown>) => void;
}>;

type ModalProviderRegistration = Readonly<{
    id: number;
    functions: ModalProviderFunctions;
}>;

class ModalManagerClass implements IModal {
    private showModalFn: ((config: Omit<ModalConfig, 'id'>) => string) | null = null;
    private hideModalFn: ((id: string) => void) | null = null;
    private hideAllModalsFn: (() => void) | null = null;
    private updateCustomModalPropsFn: ((id: string, props: Record<string, unknown>) => void) | null = null;
    private providerRegistrations: ModalProviderRegistration[] = [];
    private nextProviderRegistrationId = 0;
    private confirmResolvers: Map<string, (value: boolean) => void> = new Map();
    private promptResolvers: Map<string, (value: string | null) => void> = new Map();
    private alertResolvers: Map<string, () => void> = new Map();

    setFunctions(
        showModal: (config: Omit<ModalConfig, 'id'>) => string,
        hideModal: (id: string) => void,
        hideAllModals: () => void,
        updateCustomModalProps: (id: string, props: Record<string, unknown>) => void = () => {},
    ) {
        this.providerRegistrations = [{
            id: this.createProviderRegistrationId(),
            functions: {
                showModal,
                hideModal,
                hideAllModals,
                updateCustomModalProps,
            },
        }];
        this.applyCurrentProviderRegistration();
    }

    registerProvider(functions: ModalProviderFunctions): () => void {
        const id = this.createProviderRegistrationId();
        this.providerRegistrations = [
            ...this.providerRegistrations,
            { id, functions },
        ];
        this.applyCurrentProviderRegistration();

        let isRegistered = true;

        return () => {
            if (!isRegistered) {
                return;
            }

            isRegistered = false;
            this.providerRegistrations = this.providerRegistrations.filter((registration) => registration.id !== id);
            this.applyCurrentProviderRegistration();
        };
    }

    private createProviderRegistrationId(): number {
        const id = this.nextProviderRegistrationId;
        this.nextProviderRegistrationId += 1;
        return id;
    }

    private applyCurrentProviderRegistration(): void {
        const currentRegistration = this.providerRegistrations[this.providerRegistrations.length - 1];

        this.showModalFn = currentRegistration?.functions.showModal ?? null;
        this.hideModalFn = currentRegistration?.functions.hideModal ?? null;
        this.hideAllModalsFn = currentRegistration?.functions.hideAllModals ?? null;
        this.updateCustomModalPropsFn = currentRegistration?.functions.updateCustomModalProps ?? null;
    }

    alert(title: string, message?: string, buttons?: AlertButton[]): void {
        if (Platform.OS === 'web') {
            // Show custom web modal
            if (!this.showModalFn) {
                console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
                return;
            }

            this.showModalFn({
                type: 'alert',
                title,
                message,
                buttons: buttons || [{ text: t('common.ok') }]
            } as Omit<ModalConfig, 'id'>);
        } else {
            // Use native alert
            Alert.alert(title, message, buttons);
        }
    }

    async alertAsync(title: string, message?: string, buttons?: AlertButton[]): Promise<void> {
        if (Platform.OS === 'web') {
            if (!this.showModalFn) {
                console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
                return;
            }

            const modalId = this.showModalFn({
                type: 'alert',
                title,
                message,
                buttons: buttons || [{ text: t('common.ok') }],
            } as Omit<ModalConfig, 'id'>);

            return new Promise<void>((resolve) => {
                this.alertResolvers.set(modalId, resolve);
            });
        }

        return new Promise<void>((resolve) => {
            let resolved = false;
            const resolveOnce = () => {
                if (resolved) return;
                resolved = true;
                resolve();
            };

            const safeButtons = (buttons && buttons.length > 0 ? buttons : [{ text: t('common.ok') }]).map((btn) => ({
                ...btn,
                onPress: () => {
                    try {
                        btn.onPress?.();
                    } finally {
                        resolveOnce();
                    }
                },
            }));

            Alert.alert(title, message, safeButtons, { cancelable: false });
        });
    }

    async confirm(
        title: string,
        message?: string,
        options?: {
            cancelText?: string;
            confirmText?: string;
            destructive?: boolean;
        }
    ): Promise<boolean> {
        if (Platform.OS === 'web') {
            // Show custom web modal
            if (!this.showModalFn) {
                console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
                return false;
            }

            const modalId = this.showModalFn({
                type: 'confirm',
                title,
                message,
                cancelText: options?.cancelText,
                confirmText: options?.confirmText,
                destructive: options?.destructive
            } as Omit<ModalConfig, 'id'>);

            return new Promise<boolean>((resolve) => {
                this.confirmResolvers.set(modalId, resolve);
            });
        } else {
            // Use native alert
            return new Promise<boolean>((resolve) => {
                Alert.alert(
                    title,
                    message,
                    [
                        {
                            text: options?.cancelText || t('common.cancel'),
                            style: 'cancel',
                            onPress: () => resolve(false)
                        },
                        {
                            text: options?.confirmText || t('common.ok'),
                            style: options?.destructive ? 'destructive' : 'default',
                            onPress: () => resolve(true)
                        }
                    ],
                    { cancelable: false }
                );
            });
        }
    }

    show<C extends CustomModalComponentType<any>>(config: CustomModalShowConfig<C>): string {
        if (!this.showModalFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return '';
        }

        const modalConfig: Omit<CustomModalConfig<CustomModalInjectedProps>, 'id'> = {
            type: 'custom',
            ...(config as unknown as Omit<CustomModalConfig<CustomModalInjectedProps>, 'id' | 'type'>),
        };

        return this.showModalFn(modalConfig as Omit<ModalConfig, 'id'>);
    }

    update<P extends CustomModalInjectedProps>(
        id: string,
        props: Partial<Omit<P, keyof CustomModalInjectedProps>>,
    ): void {
        if (!this.updateCustomModalPropsFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return;
        }

        this.updateCustomModalPropsFn(id, props as Record<string, unknown>);
    }

    hide(id: string): void {
        if (!this.hideModalFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return;
        }

        this.hideModalFn(id);
    }

    hideAll(): void {
        if (!this.hideAllModalsFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return;
        }

        this.hideAllModalsFn();
    }

    resolveConfirm(id: string, value: boolean): void {
        const resolver = this.confirmResolvers.get(id);
        if (resolver) {
            resolver(value);
            this.confirmResolvers.delete(id);
        }
    }

    resolveAlert(id: string): void {
        const resolver = this.alertResolvers.get(id);
        if (resolver) {
            resolver();
            this.alertResolvers.delete(id);
        }
    }

    resolvePrompt(id: string, value: string | null): void {
        const resolver = this.promptResolvers.get(id);
        if (resolver) {
            resolver(value);
            this.promptResolvers.delete(id);
        }
    }

    async prompt(
        title: string,
        message?: string,
        options?: {
            placeholder?: string;
            defaultValue?: string;
            cancelText?: string;
            confirmText?: string;
            inputType?: 'default' | 'secure-text' | 'email-address' | 'numeric';
        }
    ): Promise<string | null> {
        // Use custom modal everywhere (iOS/Android/web) so behavior is consistent.
        if (!this.showModalFn) {
            console.error('ModalManager not initialized. Make sure ModalProvider is mounted.');
            return null;
        }

        const modalId = this.showModalFn({
            type: 'prompt',
            title,
            message,
            placeholder: options?.placeholder,
            defaultValue: options?.defaultValue,
            cancelText: options?.cancelText,
            confirmText: options?.confirmText,
            inputType: options?.inputType
        } as Omit<ModalConfig, 'id'>);

        return new Promise<string | null>((resolve) => {
            this.promptResolvers.set(modalId, resolve);
        });
    }
}

export const Modal = new ModalManagerClass();
