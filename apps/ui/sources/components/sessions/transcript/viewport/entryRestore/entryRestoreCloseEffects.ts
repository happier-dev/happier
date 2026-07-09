import type {
    TranscriptViewportTelemetryObservationReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { EntryRestoreTransactionOutcome } from './entryRestoreTransaction';
import type { TranscriptViewportMode } from '../transcriptViewportTypes';
import type { TranscriptViewportTransactionOutcome } from '../transcriptViewportOwnership';

export type EntryRestoreClosePlatform = 'native' | 'web';

export type EntryRestoreCloseWriteContext = Readonly<{
    distanceFromBottom?: number;
    issuedContentHeight?: number;
    issuedLayoutHeight?: number;
    kind?: 'anchor' | 'distance' | 'bottom' | 'slice-anchor';
}>;

export type EntryRestoreCloseEffect =
    | Readonly<{
        outcome: TranscriptViewportTransactionOutcome;
        type: 'close-entry-ownership';
    }>
    | Readonly<{
        contentHeight?: number;
        layoutHeight?: number;
        mode: TranscriptViewportMode;
        offsetY?: number;
        reason: TranscriptViewportTelemetryObservationReason;
        type: 'restore-decision';
    }>
    | Readonly<{
        mode: TranscriptViewportMode;
        offsetY?: number;
        reason: TranscriptViewportTelemetryObservationReason;
        sessionId: string;
        type: 'restore-decision-for-session';
    }>
    | Readonly<{
        type: 'native-initial-viewport-applied';
    }>
    | Readonly<{
        type: 'release-native-entry-paint';
    }>
    | Readonly<{
        type: 'reveal-entry-slice-window';
    }>;

export function resolveEntryRestoreCloseEffects(params: Readonly<{
    currentSessionId: string;
    outcome: EntryRestoreTransactionOutcome | null;
    platform: EntryRestoreClosePlatform;
    sessionId: string;
    writeContext: EntryRestoreCloseWriteContext | null;
}>): readonly EntryRestoreCloseEffect[] {
    const ownershipOutcome = resolveEntryOwnershipOutcome(params.outcome);
    const effects: EntryRestoreCloseEffect[] = [
        { outcome: ownershipOutcome, type: 'close-entry-ownership' },
        {
            ...resolveRestoreDecisionFields(params.writeContext),
            reason: resolveRestoreDecisionReason(params.outcome),
            type: 'restore-decision',
        },
    ];

    const currentNativeClose =
        params.platform === 'native' &&
        params.sessionId === params.currentSessionId;
    if (!currentNativeClose) return effects;

    effects.push(
        params.outcome === 'confirmed'
            ? { type: 'native-initial-viewport-applied' }
            : { type: 'release-native-entry-paint' },
    );
    if (params.writeContext?.kind === 'slice-anchor') {
        effects.push({ type: 'reveal-entry-slice-window' });
    }
    return effects;
}

export function resolveEntryRestoreDisposeEffects(params: Readonly<{
    sessionId: string;
    writeContext: EntryRestoreCloseWriteContext | null;
}>): readonly EntryRestoreCloseEffect[] {
    return [
        { outcome: 'preempted', type: 'close-entry-ownership' },
        {
            mode: resolveRestoreDecisionMode(params.writeContext),
            offsetY: params.writeContext?.distanceFromBottom,
            reason: 'skipped',
            sessionId: params.sessionId,
            type: 'restore-decision-for-session',
        },
    ];
}

function resolveEntryOwnershipOutcome(
    outcome: EntryRestoreTransactionOutcome | null,
): TranscriptViewportTransactionOutcome {
    if (outcome === 'preempted-user-scroll') return 'preempted';
    if (outcome === 'deadline') return 'deadline';
    return 'confirmed';
}

function resolveRestoreDecisionReason(
    outcome: EntryRestoreTransactionOutcome | null,
): TranscriptViewportTelemetryObservationReason {
    if (outcome === 'confirmed') return 'restored';
    if (outcome === 'deadline') return 'not-ready';
    return 'skipped';
}

function resolveRestoreDecisionFields(
    writeContext: EntryRestoreCloseWriteContext | null,
): Readonly<{
    contentHeight?: number;
    layoutHeight?: number;
    mode: TranscriptViewportMode;
    offsetY?: number;
}> {
    return {
        contentHeight: writeContext?.issuedContentHeight,
        layoutHeight: writeContext?.issuedLayoutHeight,
        mode: resolveRestoreDecisionMode(writeContext),
        offsetY: writeContext?.distanceFromBottom,
    };
}

function resolveRestoreDecisionMode(
    writeContext: EntryRestoreCloseWriteContext | null,
): TranscriptViewportMode {
    if (writeContext?.kind === 'anchor' || writeContext?.kind === 'slice-anchor') return 'restore-anchor';
    if (writeContext?.kind === 'bottom') return 'follow-bottom';
    return 'restore-distance';
}
