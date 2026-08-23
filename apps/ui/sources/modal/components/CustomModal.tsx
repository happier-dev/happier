import React from 'react';
import { BaseModal } from './BaseModal';
import {
    CustomModalConfig,
    type CustomModalChromeConfig,
    type CustomModalDismissReason,
} from '../types';
import { ModalCardFrame } from './card/ModalCardFrame';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
    showBackdrop?: boolean;
    visible: boolean;
    zIndexBase?: number;
}

function isPromiseLikeDismissDecision(value: unknown): value is PromiseLike<boolean | void> {
    return typeof value === 'object'
        && value !== null
        && 'then' in value
        && typeof value.then === 'function';
}

function areViewportMarginsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (typeof a === 'number' || typeof b === 'number') {
        return typeof a === 'number' && typeof b === 'number' && a === b;
    }
    if (typeof a !== 'object' || typeof b !== 'object') return false;

    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    return aRecord.horizontal === bRecord.horizontal
        && aRecord.vertical === bRecord.vertical;
}

function areDimensionOptionsEqual(
    a: Record<string, unknown> | null | undefined,
    b: Record<string, unknown> | null | undefined,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.size === b.size
        && a.width === b.width
        && a.maxHeightRatio === b.maxHeightRatio
        && areViewportMarginsEqual(a.viewportMargin, b.viewportMargin);
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
            && a.scrollHost === b.scrollHost
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
            scrollHost: override.scrollHost !== undefined ? override.scrollHost : base.scrollHost,
            bodyScroll: override.bodyScroll !== undefined ? override.bodyScroll : base.bodyScroll,
            dimensions: mergedDimensions,
        };
    }

    return override;
}

export function CustomModal({ config, onClose, showBackdrop = true, visible, zIndexBase }: CustomModalProps) {
    const Component = config.component;
    const dismissible = config.dismissible !== false;
    const dismissalPendingRef = React.useRef(false);
    const [chromeOverride, setChromeOverride] = React.useState<CustomModalChromeConfig | null | undefined>(undefined);
    const effectiveChrome = chromeOverride === undefined ? config.chrome : chromeOverride;
    const chrome = effectiveChrome?.kind === 'card' ? effectiveChrome : null;
    const accessibilityLabel = config.accessibilityLabel
        ?? (typeof chrome?.title === 'string' ? chrome.title : undefined);

    const completeDismiss = React.useCallback((notifyRequestClose: boolean) => {
        if (notifyRequestClose) {
            try {
                config.onRequestClose?.();
            } catch {
                // A legacy dismissal observer cannot prevent closure.
            }
        }
        onClose();
    }, [config.onRequestClose, onClose]);

    const requestDismiss = React.useCallback((reason: CustomModalDismissReason, notifyRequestClose: boolean) => {
        const dismissalGuard = config.onDismissRequest;
        if (!dismissalGuard) {
            completeDismiss(notifyRequestClose);
            return;
        }
        if (dismissalPendingRef.current) {
            return;
        }

        let decision: boolean | void | PromiseLike<boolean | void>;
        try {
            decision = dismissalGuard(reason);
        } catch {
            // A guard error leaves the modal open.
            return;
        }

        if (!isPromiseLikeDismissDecision(decision)) {
            if (decision !== false) {
                completeDismiss(notifyRequestClose);
            }
            return;
        }

        dismissalPendingRef.current = true;
        void Promise.resolve(decision)
            .then((allowed) => {
                if (allowed !== false) {
                    completeDismiss(notifyRequestClose);
                }
            })
            .catch(() => {
                // A rejected guard leaves the modal open without an unhandled rejection.
            })
            .finally(() => {
                dismissalPendingRef.current = false;
            });
    }, [completeDismiss, config.onDismissRequest]);

    const handleSharedDismiss = React.useCallback(() => {
        if (!dismissible) {
            return;
        }
        requestDismiss('shared', true);
    }, [dismissible, requestDismiss]);

    const handleComponentClose = React.useCallback(() => {
        requestDismiss('action', dismissible);
    }, [dismissible, requestDismiss]);

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

    // Card chrome is derived from the modal content's own render output, so applying it must not
    // feed back into that render. Holding the content element identity stable lets React skip the
    // content subtree whenever only chrome state changed; without that, a consumer whose chrome
    // dependencies are not referentially stable republishes on every applied chrome and the
    // publish cycle never closes.
    const content = React.useMemo(() => (
        <Component {...config.props} onClose={handleComponentClose} setChrome={setChrome} />
    ), [Component, config.props, handleComponentClose, setChrome]);

    return (
        <BaseModal
            visible={visible}
            onClose={handleSharedDismiss}
            accessibilityLabel={accessibilityLabel}
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
                    scrollHost={chrome.scrollHost}
                    bodyScroll={chrome.bodyScroll ?? 'none'}
                    dimensions={chrome.dimensions}
                    onClose={dismissible ? handleSharedDismiss : undefined}
                >
                    {content}
                </ModalCardFrame>
            ) : (
                content
            )}
        </BaseModal>
    );
}
