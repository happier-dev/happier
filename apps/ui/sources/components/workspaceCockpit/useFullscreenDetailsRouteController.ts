import * as React from 'react';

export type FullscreenDetailsRouteController = Readonly<{
    onRequestClose: () => void;
}>;

export type UseFullscreenDetailsRouteControllerInput = Readonly<{
    resetKey: string | null;
    enabled: boolean;
    isFocused: boolean;
    hydrated: boolean;
    detailsIsOpen: boolean;
    hasDetails: boolean;
    keepRouteWhenEmpty?: boolean;
    keepRouteWhenDetailsClose?: boolean;
    onDismissRoute: () => void;
    onRequestCloseRoute?: () => void;
    onCloseDetails: () => void;
    onUnmount?: () => void;
}>;

export function useFullscreenDetailsRouteController(
    input: UseFullscreenDetailsRouteControllerInput,
): FullscreenDetailsRouteController {
    const lastDismissalSignatureRef = React.useRef<string | null>(null);
    const previousDetailsIsOpenRef = React.useRef(input.detailsIsOpen);
    const onUnmountRef = React.useRef(input.onUnmount);

    React.useEffect(() => {
        onUnmountRef.current = input.onUnmount;
    }, [input.onUnmount]);

    React.useEffect(() => {
        lastDismissalSignatureRef.current = null;
        previousDetailsIsOpenRef.current = input.detailsIsOpen;
    }, [input.resetKey]);

    React.useEffect(() => {
        return () => {
            onUnmountRef.current?.();
        };
    }, []);

    const dismissRoute = React.useCallback(() => {
        const signature = [
            input.resetKey ?? '',
            input.keepRouteWhenEmpty === true ? 'keep-empty' : 'drop-empty',
            input.keepRouteWhenDetailsClose === true ? 'keep-close' : 'drop-close',
            input.detailsIsOpen ? 'open' : 'closed',
            input.hasDetails ? 'has-details' : 'no-details',
        ].join('|');

        if (lastDismissalSignatureRef.current === signature) return;

        lastDismissalSignatureRef.current = signature;
        input.onDismissRoute();
    }, [
        input.detailsIsOpen,
        input.hasDetails,
        input.keepRouteWhenDetailsClose,
        input.keepRouteWhenEmpty,
        input.onDismissRoute,
        input.resetKey,
    ]);

    React.useEffect(() => {
        if (!input.enabled) {
            previousDetailsIsOpenRef.current = input.detailsIsOpen;
            return;
        }
        if (!input.isFocused) {
            previousDetailsIsOpenRef.current = input.detailsIsOpen;
            return;
        }
        if (!input.hydrated) {
            previousDetailsIsOpenRef.current = input.detailsIsOpen;
            return;
        }

        const wasDetailsOpen = previousDetailsIsOpenRef.current;
        previousDetailsIsOpenRef.current = input.detailsIsOpen;

        if (wasDetailsOpen && !input.detailsIsOpen && input.keepRouteWhenDetailsClose !== true) {
            dismissRoute();
            return;
        }

        if (!input.hasDetails && input.keepRouteWhenEmpty !== true) {
            dismissRoute();
        }
    }, [
        dismissRoute,
        input.detailsIsOpen,
        input.enabled,
        input.hasDetails,
        input.hydrated,
        input.isFocused,
        input.keepRouteWhenDetailsClose,
        input.keepRouteWhenEmpty,
    ]);

    const onRequestClose = React.useCallback(() => {
        const dismissRequestedRoute = input.onRequestCloseRoute ?? dismissRoute;
        if (input.detailsIsOpen) {
            input.onCloseDetails();
            dismissRequestedRoute();
            return;
        }
        dismissRequestedRoute();
    }, [dismissRoute, input.detailsIsOpen, input.onCloseDetails, input.onRequestCloseRoute]);

    return {
        onRequestClose,
    };
}
