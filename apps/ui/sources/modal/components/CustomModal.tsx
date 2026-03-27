import React from 'react';
import { BaseModal } from './BaseModal';
import { CustomModalConfig, type CustomModalChromeConfig } from '../types';
import { ModalCardFrame } from './card/ModalCardFrame';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
    showBackdrop?: boolean;
    zIndexBase?: number;
}

function areDimensionOptionsEqual(
    a: Record<string, unknown> | null | undefined,
    b: Record<string, unknown> | null | undefined,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.size === b.size
        && a.width === b.width
        && a.maxHeightRatio === b.maxHeightRatio;
}

function areChromeConfigsEqual(
    a: CustomModalChromeConfig | null | undefined,
    b: CustomModalChromeConfig | null,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;

    if (a.kind === 'card' && b.kind === 'card') {
        return a.title === b.title
            && a.subtitle === b.subtitle
            && a.leading === b.leading
            && a.actions === b.actions
            && a.footer === b.footer
            && a.testID === b.testID
            && a.titleTestID === b.titleTestID
            && a.subtitleTestID === b.subtitleTestID
            && a.closeButtonTestID === b.closeButtonTestID
            && a.layout === b.layout
            && areDimensionOptionsEqual(
                (a.dimensions ?? null) as Record<string, unknown> | null,
                (b.dimensions ?? null) as Record<string, unknown> | null,
            );
    }

    return false;
}

export function CustomModal({ config, onClose, showBackdrop = true, zIndexBase }: CustomModalProps) {
    const Component = config.component;
    const [chromeOverride, setChromeOverride] = React.useState<CustomModalChromeConfig | null | undefined>(undefined);
    const effectiveChrome = chromeOverride === undefined ? config.chrome : chromeOverride;
    const chrome = effectiveChrome?.kind === 'card' ? effectiveChrome : null;

    const handleClose = React.useCallback(() => {
        try {
            config.onRequestClose?.();
        } catch {
            // ignore
        }

        try {
            const maybeRequestClose = config.props != null && typeof config.props === 'object'
                ? (config.props as Record<string, unknown>).onRequestClose
                : undefined;

            if (typeof maybeRequestClose === 'function') {
                maybeRequestClose();
            }
        } catch {
            // ignore
        }
        onClose();
    }, [config.onRequestClose, config.props, onClose]);

    const setChrome = React.useCallback((nextChrome: CustomModalChromeConfig | null) => {
        setChromeOverride((prev) => (areChromeConfigsEqual(prev, nextChrome) ? prev : nextChrome));
    }, []);

    return (
        <BaseModal
            visible={true}
            onClose={handleClose}
            closeOnBackdrop={config.closeOnBackdrop ?? true}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
        >
            {chrome ? (
                <ModalCardFrame
                    leading={chrome.leading}
                    title={chrome.title}
                    subtitle={chrome.subtitle}
                    actions={chrome.actions}
                    footer={chrome.footer}
                    testID={chrome.testID}
                    titleTestID={chrome.titleTestID}
                    subtitleTestID={chrome.subtitleTestID}
                    closeButtonTestID={chrome.closeButtonTestID}
                    layout={chrome.layout ?? 'fit'}
                    dimensions={chrome.dimensions}
                    onClose={handleClose}
                >
                    <Component {...config.props} onClose={handleClose} setChrome={setChrome} />
                </ModalCardFrame>
            ) : (
                <Component {...config.props} onClose={handleClose} setChrome={setChrome} />
            )}
        </BaseModal>
    );
}
