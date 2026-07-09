import {
    type TranscriptViewportCommandController,
    type TranscriptViewportRejectedWrite,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import type { TranscriptViewportTransactionOutcome } from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import { performTranscriptViewportCommand } from '@/components/sessions/transcript/viewport/performTranscriptViewportCommand';
import type {
    WebTranscriptPrependAnchor,
    WebTranscriptPrependRestoreResult,
    WebTranscriptViewportAnchor,
    WebTranscriptViewportAnchorRestoreResult,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import {
    performWebDomPrependAnchorRestoreCommand,
    performWebDomVisibleAnchorRestoreCommand,
} from './webDom';
import { resolveIndexScrollWriter } from './nativeInvertedFlashList';
import type { TranscriptViewportDriverDeps } from './types';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportScrollReason,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptViewportTelemetryScrollWriter } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

export type TranscriptViewportCommandHost = Readonly<{
    execute: (command: TranscriptViewportCommand) => boolean;
    executeWithAnimation: (command: TranscriptViewportCommand, animated: boolean) => boolean;
    resolve: (input: TranscriptViewportControllerInput) => TranscriptViewportCommand;
    restoreWebPrependAnchor: (params: Readonly<{
        anchor: WebTranscriptPrependAnchor;
        sessionId: string;
    }>) => WebTranscriptPrependRestoreResult;
    restoreWebVisibleAnchor: (params: Readonly<{
        anchor: WebTranscriptViewportAnchor;
        animated?: boolean;
        itemIndex?: number | null;
        reason?: Extract<TranscriptViewportScrollReason, 'content-size-change' | 'entry-restore'>;
        sessionId: string;
    }>) => WebTranscriptViewportAnchorRestoreResult;
}>;

export type TranscriptViewportCommandHostDeps = Readonly<{
    clearWebPrependRestoreWindow: (outcome: TranscriptViewportTransactionOutcome) => void;
    controller: TranscriptViewportCommandController;
    driverDeps: TranscriptViewportDriverDeps;
    hasWebPrependRestoreWindow: () => boolean;
    isWeb: () => boolean;
}>;

export function createTranscriptViewportCommandHost(
    deps: TranscriptViewportCommandHostDeps,
): TranscriptViewportCommandHost {
    const performThroughController = (
        command: TranscriptViewportCommand,
        perform: (commandToPerform: TranscriptViewportCommand) => boolean,
    ): boolean => deps.controller.execute(command, {
        clearWebPrependRestoreWindow: deps.clearWebPrependRestoreWindow,
        hasWebPrependRestoreWindow: deps.hasWebPrependRestoreWindow,
        isWeb: deps.isWeb(),
        perform,
        recordRejectedWrite: (write) => recordRejectedWriteTelemetry(write, deps),
    });

    const execute = (command: TranscriptViewportCommand): boolean => {
        return performThroughController(command, (commandToPerform) => (
            performTranscriptViewportCommand(commandToPerform, deps.driverDeps)
        ));
    };

    return {
        execute,
        executeWithAnimation(command, animated) {
            return execute(withTranscriptViewportCommandAnimation(command, animated));
        },
        resolve(input) {
            return deps.controller.resolve(input);
        },
        restoreWebPrependAnchor(params) {
            let restoreResult: WebTranscriptPrependRestoreResult = {
                didAdjustScroll: false,
                strategy: 'none',
            };
            const command = deps.controller.resolve({
                type: 'restore-web-prepend-anchor',
                sessionId: params.sessionId,
                anchor: params.anchor,
                animated: false,
            });
            performThroughController(command, (commandToPerform) => {
                if (commandToPerform.kind !== 'restore-web-prepend-anchor') return false;
                restoreResult = performWebDomPrependAnchorRestoreCommand(commandToPerform, deps.driverDeps);
                return true;
            });
            return restoreResult;
        },
        restoreWebVisibleAnchor(params) {
            let restoreResult: WebTranscriptViewportAnchorRestoreResult = {
                didAdjustScroll: false,
                status: 'not_applied',
            };
            const command = deps.controller.resolve({
                type: 'restore-visible-anchor',
                sessionId: params.sessionId,
                reason: params.reason ?? 'entry-restore',
                anchor: {
                    kind: params.anchor.kind,
                    itemId: params.anchor.itemId,
                    messageId: params.anchor.messageId ?? null,
                },
                itemIndex: params.itemIndex,
                itemOffsetPx: params.anchor.itemOffsetPx,
                animated: params.animated ?? false,
            });
            performThroughController(command, (commandToPerform) => {
                if (commandToPerform.kind !== 'restore-visible-anchor') return false;
                restoreResult = performWebDomVisibleAnchorRestoreCommand(commandToPerform, deps.driverDeps);
                return restoreResult.status === 'restored' || restoreResult.status === 'already_aligned';
            });
            return restoreResult;
        },
    };
}

export function withTranscriptViewportCommandAnimation(
    command: TranscriptViewportCommand,
    animated: boolean,
): TranscriptViewportCommand {
    switch (command.kind) {
        case 'pin-bottom':
        case 'restore-distance':
        case 'apply-history-correction':
        case 'restore-anchor':
        case 'restore-visible-anchor':
        case 'jump-to-seq':
        case 'recover-jump-to-seq':
        case 'preserve-live-tail-distance':
        case 'restore-web-prepend-anchor':
            return { ...command, animated };
        case 'none':
        case 'skip-native-js-pin':
            return command;
    }
}

function recordRejectedWriteTelemetry(
    write: TranscriptViewportRejectedWrite,
    deps: TranscriptViewportCommandHostDeps,
): void {
    const { command } = write;
    deps.driverDeps.recordViewportTelemetryEvent({
        type: 'scroll-write-rejected',
        writer: resolveRejectedWriteTelemetryWriter(command, deps),
        reason: command.reason,
        rejectedOwner: write.rejectedOwner,
        activeOwner: write.activeOwner,
        mode: command.mode,
        targetOffsetY: resolveRejectedViewportCommandTelemetryTargetOffsetY(command),
        layoutHeight: deps.driverDeps.listLayoutHeightRef.current,
        contentHeight: deps.driverDeps.listContentHeightRef.current,
        nativeMountSettleStable: deps.driverDeps.nativeMountSettleStable,
    });
}

function resolveRejectedWriteTelemetryWriter(
    command: TranscriptViewportCommand,
    deps: TranscriptViewportCommandHostDeps,
): TranscriptViewportTelemetryScrollWriter {
    if (command.kind === 'none' || command.kind === 'skip-native-js-pin') return 'mvcp-skip';
    if (command.kind === 'restore-anchor' || command.kind === 'jump-to-seq') {
        return resolveIndexScrollWriter({ platform: deps.driverDeps.telemetryPlatform });
    }
    if (deps.isWeb()) {
        return command.kind === 'pin-bottom' || command.mode === 'follow-bottom'
            ? 'web-dom-bottom'
            : 'web-dom-restore';
    }
    return command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset';
}

function resolveRejectedViewportCommandTelemetryTargetOffsetY(
    command: TranscriptViewportCommand,
): number | undefined {
    switch (command.kind) {
        case 'restore-distance':
            return command.distanceFromLiveTailPx;
        case 'apply-history-correction':
            return command.targetDistanceFromHistoryStartPx;
        case 'jump-to-seq':
            return command.seq;
        case 'recover-jump-to-seq':
            return command.failedRenderedIndex * command.averageItemLengthPx;
        case 'preserve-live-tail-distance':
            return command.previousDistanceFromLiveTailPx;
        case 'restore-visible-anchor':
        case 'restore-web-prepend-anchor':
        case 'restore-anchor':
        case 'pin-bottom':
        case 'none':
        case 'skip-native-js-pin':
            return undefined;
    }
}
