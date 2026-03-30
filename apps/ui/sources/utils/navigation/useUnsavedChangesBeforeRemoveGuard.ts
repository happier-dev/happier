import * as React from 'react';

import { fireAndForget } from '@/utils/system/fireAndForget';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

export type { UnsavedChangesDecision };

export function useUnsavedChangesBeforeRemoveGuard(params: Readonly<{
    navigation: unknown;
    enabled?: boolean;
    ignoreRef?: React.MutableRefObject<boolean>;
    isDirtyRef: React.MutableRefObject<boolean>;
    requestDecision: () => Promise<UnsavedChangesDecision>;
    onDiscard?: () => void;
    onSave?: () => boolean | Promise<boolean>;
    continueOnSave?: boolean;
    onContinue: (action: unknown) => void;
    tag: string;
}>) {
    const {
        navigation,
        enabled: enabledParam,
        ignoreRef,
        isDirtyRef,
        requestDecision,
        onDiscard,
        onSave,
        continueOnSave,
        onContinue,
        tag,
    } = params;
    const enabled = enabledParam ?? true;

    React.useEffect(() => {
        if (!enabled) return;

        const nav: any = navigation;
        const addListener = nav?.addListener;
        if (typeof addListener !== 'function') {
            return;
        }

        const subscription = addListener.call(nav, 'beforeRemove', (event: any) => {
            if (ignoreRef?.current) return;
            if (!isDirtyRef.current) return;

            if (typeof event?.preventDefault === 'function') {
                event.preventDefault();
            }

            const action = event?.data?.action;

            fireAndForget((async () => {
                const decision = await requestDecision();

                if (decision === 'discard') {
                    isDirtyRef.current = false;
                    onDiscard?.();
                    onContinue(action);
                    return;
                }

                if (decision === 'save') {
                    const didSave = await onSave?.() ?? false;
                    if (!didSave) return;
                    isDirtyRef.current = false;

                    if (continueOnSave !== false) {
                        onContinue(action);
                    }
                }
            })(), { tag });
        });

        return () => {
            if (typeof subscription === 'function') {
                subscription();
                return;
            }
            subscription?.remove?.();
        };
    }, [
        enabled,
        navigation,
        ignoreRef,
        isDirtyRef,
        requestDecision,
        onDiscard,
        onSave,
        continueOnSave,
        onContinue,
        tag,
    ]);
}
