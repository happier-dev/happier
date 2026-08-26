import * as React from 'react';
import type { ComponentType } from 'react';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';

import {
    TERMINAL_NATIVE_EVENT_NAMES,
    getOptionalHappierTerminalNativeModule,
    getOptionalHappierTerminalNativeViewManager,
    normalizeTerminalNativeAvailability,
    normalizeTerminalNativeEvent,
    normalizeTerminalNativeWriteResult,
    type TerminalNativeEventName,
    type TerminalNativeEventSubscription,
    type TerminalNativeModule,
    type TerminalNativeSurfaceProps,
    type TerminalNativeUnavailableReason,
} from '@happier-dev/terminal-native';
import { encodeBase64 } from '@/encryption/base64';
import { sanitizeTerminalBell, sanitizeTerminalTitle } from '@/components/terminal/interaction/title';
import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';

type NativeTerminalViewProps = Readonly<{
    surfaceId: string;
    fontSize: number;
    lineHeightPx: number;
    accessibilitySummary?: string;
    accessibilityAccepted?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    onLayout?: (event: LayoutChangeEvent) => void;
}>;

type NativeTerminalView = ComponentType<NativeTerminalViewProps>;

export type NativeTerminalSurfaceProps = TerminalNativeSurfaceProps & Readonly<{
    accessibilityAccepted?: boolean;
    accessibilitySummary?: string;
    onWriteComplete?: (event: EmbeddedTerminalWriteCompleteEvent) => void;
    testID?: string;
}>;

type PendingWrite = EmbeddedTerminalWriteCompleteEvent;

export const NativeTerminalSurface = React.forwardRef<EmbeddedTerminalRendererHandle, NativeTerminalSurfaceProps>(function NativeTerminalSurface(
    props,
    ref,
) {
    const nativeModule = React.useMemo(() => getOptionalHappierTerminalNativeModule(), []);
    const NativeView = React.useMemo(
        () => getOptionalHappierTerminalNativeViewManager<NativeTerminalView>(),
        [],
    );
    const pendingWritesRef = React.useRef<PendingWrite[]>([]);
    const propsRef = React.useRef(props);
    propsRef.current = props;

    const unavailableReason: TerminalNativeUnavailableReason | null = nativeModule && NativeView
        ? null
        : 'native-module-missing';

    React.useEffect(() => {
        if (unavailableReason) {
            props.onUnavailable?.(unavailableReason);
        }
    }, [props.onUnavailable, unavailableReason]);

    const requestNativeSurface = React.useCallback(() => {
        if (!nativeModule?.createSurface || unavailableReason) return;

        void Promise.resolve(nativeModule.createSurface(props.surfaceId))
            .then((value) => {
                if (value === undefined) return;
                const availability = normalizeTerminalNativeAvailability(value);
                if (!availability.available && availability.reason !== 'surface-not-ready') {
                    propsRef.current.onUnavailable?.(availability.reason);
                }
            })
            .catch(() => {
                propsRef.current.onUnavailable?.('renderer-unavailable');
            });
    }, [nativeModule, props.surfaceId, unavailableReason]);

    React.useEffect(() => {
        if (!nativeModule?.addListener || unavailableReason) return undefined;

        const subscriptions = TERMINAL_NATIVE_EVENT_NAMES.map((eventName) => (
            nativeModule.addListener?.(eventName, (payload) => {
                routeNativeEvent({
                    eventName,
                    payload,
                    surfaceId: propsRef.current.surfaceId,
                    pendingWrites: pendingWritesRef.current,
                    props: propsRef.current,
                });
            })
        )).filter(Boolean) as TerminalNativeEventSubscription[];

        requestNativeSurface();

        return () => {
            subscriptions.forEach((subscription) => subscription.remove());
        };
    }, [nativeModule, requestNativeSurface, unavailableReason]);

    React.useEffect(() => (
        () => {
            pendingWritesRef.current = [];
            void nativeModule?.disposeSurface?.(props.surfaceId);
        }
    ), [nativeModule, props.surfaceId]);

    React.useImperativeHandle(
        ref,
        () => ({
            write: () => false,
            writeBytes: (input) => {
                if (!nativeModule?.writeBytes || unavailableReason) return false;
                if (input.bytes.byteLength === 0 || input.byteOffset < 0) return false;

                const completion: PendingWrite = {
                    terminalId: input.terminalId,
                    seq: input.seq,
                    byteOffset: input.byteOffset,
                    byteLength: input.bytes.byteLength,
                    ackedByteOffset: input.byteOffset + input.bytes.byteLength,
                    writeGeneration: input.writeGeneration,
                };
                pendingWritesRef.current.push(completion);

                const dataBase64 = encodeBase64(input.bytes, 'base64');
                let writeResult: Promise<unknown>;
                try {
                    writeResult = Promise.resolve(nativeModule.writeBytes(props.surfaceId, dataBase64, input.byteOffset));
                } catch {
                    removePendingWrite(pendingWritesRef.current, completion);
                    return false;
                }

	                void writeResult
	                    .then((value) => {
	                        const result = normalizeTerminalNativeWriteResult(value, completion.ackedByteOffset);
	                        if (result.accepted) {
	                            completePendingWrite({
	                                pendingWrites: pendingWritesRef.current,
	                                event: completion,
	                                ackedByteOffset: result.byteOffset,
	                                onWriteComplete: propsRef.current.onWriteComplete,
	                            });
	                        } else {
                            rejectPendingWrite({
                                pendingWrites: pendingWritesRef.current,
                                event: completion,
                                onWriteComplete: propsRef.current.onWriteComplete,
                            });
                            if (result.reason === 'renderer-unavailable' || result.reason === 'surface-not-ready') {
                                propsRef.current.onUnavailable?.(result.reason);
                            }
                        }
                    })
                    .catch(() => {
                        rejectPendingWrite({
                            pendingWrites: pendingWritesRef.current,
                            event: completion,
                            onWriteComplete: propsRef.current.onWriteComplete,
                        });
                        propsRef.current.onUnavailable?.('renderer-unavailable');
                    });
                return { status: 'queued' };
            },
            clear: () => {
                void nativeModule?.clearSurface?.(props.surfaceId);
            },
            focus: () => {
                void nativeModule?.focusSurface?.(props.surfaceId);
            },
            copySelection: () => {
                if (unavailableReason) return;
                void nativeModule?.copySelection?.(props.surfaceId);
            },
        }),
        [nativeModule, props.surfaceId, unavailableReason],
    );

    if (!NativeView || unavailableReason) {
        return null;
    }

    return (
        <NativeView
            surfaceId={props.surfaceId}
            fontSize={props.fontSize}
            lineHeightPx={props.lineHeightPx}
            accessibilitySummary={props.accessibilitySummary}
            accessibilityAccepted={props.accessibilityAccepted}
            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
            testID={props.testID}
            onLayout={requestNativeSurface}
        />
    );
});

function routeNativeEvent(input: Readonly<{
    eventName: TerminalNativeEventName;
    payload: unknown;
    surfaceId: string;
    pendingWrites: PendingWrite[];
    props: NativeTerminalSurfaceProps;
}>) {
    const event = normalizeTerminalNativeEvent(input.eventName, input.payload);
    if (!event || event.surfaceId !== input.surfaceId) return;

    switch (input.eventName) {
        case 'rendererCrash':
            input.props.onRendererCrash?.(event as Parameters<NonNullable<NativeTerminalSurfaceProps['onRendererCrash']>>[0]);
            input.props.onUnavailable?.('renderer-unavailable');
            return;
        case 'surfaceReady':
            input.props.onReady((event as { cols: number; rows: number }).cols, (event as { rows: number }).rows);
            return;
	        case 'writeAck':
	            input.props.onWriteAck?.(event as Parameters<NonNullable<NativeTerminalSurfaceProps['onWriteAck']>>[0]);
	            return;
        case 'input':
            input.props.onInput((event as { data: string }).data);
            return;
        case 'resize':
            input.props.onResize((event as { cols: number; rows: number }).cols, (event as { rows: number }).rows);
            return;
        case 'link':
            input.props.onLink?.(event as Parameters<NonNullable<NativeTerminalSurfaceProps['onLink']>>[0]);
            return;
        case 'selection':
            input.props.onSelection?.(event as Parameters<NonNullable<NativeTerminalSurfaceProps['onSelection']>>[0]);
            return;
        case 'copy':
            input.props.onCopy?.(event as Parameters<NonNullable<NativeTerminalSurfaceProps['onCopy']>>[0]);
            return;
        case 'title': {
            const titleEvent = event as Parameters<NonNullable<NativeTerminalSurfaceProps['onTitle']>>[0];
            input.props.onTitle?.({
                ...titleEvent,
                title: sanitizeTerminalTitle(titleEvent.title),
            });
            return;
        }
        case 'bell': {
            const bellEvent = event as Parameters<NonNullable<NativeTerminalSurfaceProps['onBell']>>[0];
            input.props.onBell?.(bellEvent.label
                ? { ...bellEvent, label: sanitizeTerminalBell(bellEvent.label) }
                : bellEvent);
            return;
        }
    }
}

function removePendingWrite(pendingWrites: PendingWrite[], event: PendingWrite): boolean {
    const index = pendingWrites.indexOf(event);
    if (index >= 0) {
        pendingWrites.splice(index, 1);
        return true;
    }
    return false;
}

function rejectPendingWrite(input: Readonly<{
    pendingWrites: PendingWrite[];
    event: PendingWrite;
    onWriteComplete?: (event: EmbeddedTerminalWriteCompleteEvent) => void;
}>) {
    if (!removePendingWrite(input.pendingWrites, input.event)) {
        return;
    }
    input.onWriteComplete?.({
        ...input.event,
        ackedByteOffset: input.event.byteOffset,
    });
}

function completePendingWrite(input: Readonly<{
    pendingWrites: PendingWrite[];
    event: PendingWrite;
    ackedByteOffset: number;
    onWriteComplete?: (event: EmbeddedTerminalWriteCompleteEvent) => void;
}>) {
    if (!removePendingWrite(input.pendingWrites, input.event)) {
        return;
    }
    input.onWriteComplete?.({
        ...input.event,
        ackedByteOffset: Math.min(input.ackedByteOffset, input.event.ackedByteOffset),
    });
}
