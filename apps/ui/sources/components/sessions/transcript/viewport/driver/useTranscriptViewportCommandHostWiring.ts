import * as React from 'react';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
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

type MutableRef<T> = { current: T };

export function useTranscriptViewportCommandHostWiring(params: Readonly<{
    commandHostRef: MutableRef<TranscriptViewportCommandHost | null>;
    driverDeps: TranscriptViewportDriverDeps;
    platformOS: string;
    sessionId: string;
    viewportCommandController: TranscriptViewportCommandController;
}>) {
    const {
        commandHostRef,
        driverDeps,
        platformOS,
        sessionId,
        viewportCommandController,
    } = params;
    const commandHost = React.useMemo(() => createTranscriptViewportCommandHost({
        controller: viewportCommandController,
        driverDeps,
        isWeb: () => platformOS === 'web',
    }), [
        driverDeps,
        platformOS,
        viewportCommandController,
    ]);
    useCommittedTranscriptRef(commandHostRef, commandHost);

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

    return {
        executeViewportCommand,
        executeViewportCommandWithAnimation,
        resolveViewportCommand,
        restoreWebViewportAnchorThroughViewportCommand,
    };
}
