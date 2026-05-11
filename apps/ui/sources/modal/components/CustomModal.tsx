import React from 'react';
import { BaseModal } from './BaseModal';
import { CustomModalConfig, type CustomModalChromeConfig } from '../types';
import { ModalCardFrame } from './card/ModalCardFrame';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
    showBackdrop?: boolean;
    visible: boolean;
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
            && a.bodyScroll === b.bodyScroll
            && areDimensionOptionsEqual(
                (a.dimensions ?? null) as Record<string, unknown> | null,
                (b.dimensions ?? null) as Record<string, unknown> | null,
            );
    }

    return false;
}

function mergeChromeConfig(
    base: CustomModalChromeConfig | null | undefined,
    override: CustomModalChromeConfig | null | undefined,
): CustomModalChromeConfig | null {
    if (override === undefined) return base ?? null;
    if (override === null) return null;
    if (!base) return override;

    if (base.kind === 'card' && override.kind === 'card') {
        const mergedDimensions = (() => {
            if (override.dimensions === undefined) return base.dimensions;
            if (base.dimensions == null) return override.dimensions;
            return {
                ...base.dimensions,
                ...override.dimensions,
            };
        })();

        return {
            kind: 'card',
            leading: override.leading !== undefined ? override.leading : base.leading,
            title: override.title !== undefined ? override.title : base.title,
            subtitle: override.subtitle !== undefined ? override.subtitle : base.subtitle,
            actions: override.actions !== undefined ? override.actions : base.actions,
            footer: override.footer !== undefined ? override.footer : base.footer,
            testID: override.testID !== undefined ? override.testID : base.testID,
            titleTestID: override.titleTestID !== undefined ? override.titleTestID : base.titleTestID,
            subtitleTestID: override.subtitleTestID !== undefined ? override.subtitleTestID : base.subtitleTestID,
            closeButtonTestID: override.closeButtonTestID !== undefined ? override.closeButtonTestID : base.closeButtonTestID,
            layout: override.layout !== undefined ? override.layout : base.layout,
            bodyScroll: override.bodyScroll !== undefined ? override.bodyScroll : base.bodyScroll,
            dimensions: mergedDimensions,
        };
    }

    return override;
}

export function CustomModal({ config, onClose, showBackdrop = true, visible, zIndexBase }: CustomModalProps) {
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
        onClose();
    }, [config.onRequestClose, onClose]);

    const setChrome = React.useCallback((nextChrome: CustomModalChromeConfig | null) => {
        setChromeOverride((prevOverride) => {
            const prevEffective = prevOverride === undefined ? (config.chrome ?? null) : prevOverride;
            const nextEffective = mergeChromeConfig(prevEffective, nextChrome);
            if (areChromeConfigsEqual(prevEffective, nextEffective)) {
                return prevOverride;
            }
            return nextEffective;
        });
    }, [config.chrome]);

    return (
        <BaseModal
            visible={visible}
            onClose={handleClose}
            closeOnBackdrop={config.closeOnBackdrop ?? true}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
            webPortalTarget={config.webPortalTarget ?? null}
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
                    bodyScroll={chrome.bodyScroll ?? 'none'}
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
