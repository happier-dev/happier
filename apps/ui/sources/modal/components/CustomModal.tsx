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

const MAX_CHROME_NODE_COMPARE_DEPTH = 8;
const MAX_CHROME_NODE_COMPARE_ARRAY_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function areChromeNodeValuesEqual(a: unknown, b: unknown, depth: number): boolean {
    if (Object.is(a, b)) return true;
    if (depth >= MAX_CHROME_NODE_COMPARE_DEPTH) return false;
    if (typeof a !== typeof b) return false;
    if (a == null || b == null) return false;

    if (Array.isArray(a)) {
        if (!Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        if (a.length > MAX_CHROME_NODE_COMPARE_ARRAY_LENGTH) return false;
        for (let i = 0; i < a.length; i += 1) {
            if (!areChromeNodeValuesEqual(a[i], b[i], depth + 1)) return false;
        }
        return true;
    }

    if (React.isValidElement(a)) {
        if (!React.isValidElement(b)) return false;

        if (a.type !== b.type) return false;
        if (a.key !== b.key) return false;

        return areChromeNodeValuesEqual(a.props, b.props, depth + 1);
    }

    if (isPlainObject(a)) {
        if (!isPlainObject(b)) return false;
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
            if (!areChromeNodeValuesEqual(a[key], b[key], depth + 1)) return false;
        }
        return true;
    }

    return false;
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
        return areChromeNodeValuesEqual(a.title, b.title, 0)
            && areChromeNodeValuesEqual(a.subtitle, b.subtitle, 0)
            && areChromeNodeValuesEqual(a.leading, b.leading, 0)
            && areChromeNodeValuesEqual(a.actions, b.actions, 0)
            && areChromeNodeValuesEqual(a.footer, b.footer, 0)
            && a.testID === b.testID
            && a.titleTestID === b.titleTestID
            && a.subtitleTestID === b.subtitleTestID
            && a.closeButtonTestID === b.closeButtonTestID
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
            dimensions: mergedDimensions,
        };
    }

    return override;
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
