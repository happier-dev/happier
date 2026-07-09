import * as React from 'react';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptViewportCommandController } from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import {
    createTranscriptViewportCommandHost,
    type TranscriptViewportCommandHost,
} from '@/components/sessions/transcript/viewport/driver/commandHost';
import type { TranscriptViewportDriverDeps } from '@/components/sessions/transcript/viewport/driver/types';
import type {
    WebTranscriptViewportAnchor,
    WebTranscriptViewportAnchorRestoreResult,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptViewportTransactionOutcome } from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';

type MutableRef<T> = { current: T };

export function useTranscriptViewportCommandHostWiring(params: Readonly<{
    clearWebPrependRestoreWindow: (outcome: TranscriptViewportTransactionOutcome) => void;
    commandHostRef: MutableRef<TranscriptViewportCommandHost | null>;
    driverDeps: TranscriptViewportDriverDeps;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    hasWebPrependRestoreWindow: () => boolean;
    listContentHeight: number;
    listDataLength: number;
    localHeightChangeRestoreOwner: 'app' | 'renderer';
    pendingWebLocalHeightChangeAnchorRef: MutableRef<Readonly<{
        sessionId: string;
        anchor: WebTranscriptViewportAnchor;
    }> | null>;
    platformOS: string;
    sessionId: string;
    viewportCommandController: TranscriptViewportCommandController;
}>) {
    const {
        clearWebPrependRestoreWindow,
        commandHostRef,
        driverDeps,
        expandedToolCallsAnchorMessageIds,
        hasWebPrependRestoreWindow,
        listContentHeight,
        listDataLength,
        localHeightChangeRestoreOwner,
        pendingWebLocalHeightChangeAnchorRef,
        platformOS,
        sessionId,
        viewportCommandController,
    } = params;
    const commandHost = React.useMemo(() => createTranscriptViewportCommandHost({
        clearWebPrependRestoreWindow,
        controller: viewportCommandController,
        driverDeps,
        hasWebPrependRestoreWindow,
        isWeb: () => platformOS === 'web',
    }), [
        clearWebPrependRestoreWindow,
        driverDeps,
        hasWebPrependRestoreWindow,
        platformOS,
        viewportCommandController,
    ]);
    commandHostRef.current = commandHost;

    const resolveViewportCommand = React.useCallback((input: TranscriptViewportControllerInput): TranscriptViewportCommand => {
        return commandHost.resolve(input);
    }, [commandHost]);
    const executeViewportCommand = React.useCallback((command: TranscriptViewportCommand): boolean => {
        return commandHost.execute(command);
    }, [commandHost]);
    const executeViewportCommandWithAnimation = React.useCallback((
        command: TranscriptViewportCommand,
        animated: boolean,
    ): boolean => {
        return commandHost.executeWithAnimation(command, animated);
    }, [commandHost]);
    const restoreWebViewportAnchorThroughViewportCommand = React.useCallback((restoreParams: Readonly<{
        anchor: WebTranscriptViewportAnchor;
        itemIndex?: number | null;
        reason?: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'entry-restore'>;
    }>): WebTranscriptViewportAnchorRestoreResult => {
        return commandHost.restoreWebVisibleAnchor({
            anchor: restoreParams.anchor,
            animated: false,
            itemIndex: restoreParams.itemIndex,
            reason: restoreParams.reason,
            sessionId,
        });
    }, [commandHost, sessionId]);

    React.useLayoutEffect(() => {
        if (localHeightChangeRestoreOwner === 'renderer') {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return;
        }
        if (platformOS !== 'web') return;
        const pending = pendingWebLocalHeightChangeAnchorRef.current;
        if (!pending) return;
        if (pending.sessionId !== sessionId) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return;
        }
        pendingWebLocalHeightChangeAnchorRef.current = null;
        restoreWebViewportAnchorThroughViewportCommand({
            anchor: pending.anchor,
            reason: 'content-size-change',
        });
    }, [
        expandedToolCallsAnchorMessageIds,
        listContentHeight,
        listDataLength,
        localHeightChangeRestoreOwner,
        pendingWebLocalHeightChangeAnchorRef,
        platformOS,
        restoreWebViewportAnchorThroughViewportCommand,
        sessionId,
    ]);

    return {
        executeViewportCommand,
        executeViewportCommandWithAnimation,
        resolveViewportCommand,
        restoreWebViewportAnchorThroughViewportCommand,
    };
}
