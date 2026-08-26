import * as React from 'react';
import { AccessibilityInfo } from 'react-native';

import {
    focusNativeAccessibilityTarget,
    type FocusReturnTarget,
} from '@/keyboard/focusReturn';

type FieldTargetMap = Record<string, FocusReturnTarget>;

/** A stable, per-field error-node id for labels, hints, and screen readers. */
export function connectedAccountFieldErrorId(prefix: string, fieldId: string): string {
    return `${prefix}:${fieldId}:error`;
}

/**
 * Keeps validation recovery local to a form while using the app's canonical
 * native/web focus primitives. The first invalid field gets physical focus
 * when possible and an accessibility announcement always describes the
 * recovery state.
 */
export function useConnectedAccountInvalidFieldFocus(input: Readonly<{
    invalidFieldIds: readonly string[];
    announcement: string;
}>): (fieldId: string) => (target: FocusReturnTarget) => void {
    const targetsRef = React.useRef<FieldTargetMap>({});
    const callbacksRef = React.useRef<Record<string, (target: FocusReturnTarget) => void>>({});
    const announcedFingerprintRef = React.useRef('');

    React.useEffect(() => {
        if (input.invalidFieldIds.length === 0) {
            announcedFingerprintRef.current = '';
            return;
        }
        const fingerprint = input.invalidFieldIds.join('\u0000');
        if (announcedFingerprintRef.current === fingerprint) return;
        announcedFingerprintRef.current = fingerprint;
        const firstInvalidFieldId = input.invalidFieldIds[0];
        const target = targetsRef.current[firstInvalidFieldId];
        if (target && typeof target === 'object' && typeof target.focus === 'function') {
            try {
                target.focus();
            } catch {
                // Keep the live announcement available when a platform host
                // cannot take physical focus.
            }
        }
        focusNativeAccessibilityTarget(target);
        try {
            AccessibilityInfo.announceForAccessibility?.(input.announcement);
        } catch {
            // Native announcements are best effort; the inline alert is the
            // durable semantic recovery surface.
        }
    }, [input.announcement, input.invalidFieldIds]);

    return React.useCallback((fieldId: string) => {
        const current = callbacksRef.current[fieldId];
        if (current) return current;
        const callback = (target: FocusReturnTarget) => {
            targetsRef.current[fieldId] = target;
        };
        callbacksRef.current[fieldId] = callback;
        return callback;
    }, []);
}
