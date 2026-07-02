import type { TranscriptViewportOwner } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

/**
 * Pure phase-ownership state machine for transcript viewport writes (no React, no timers).
 *
 * At any moment exactly one owner may issue viewport commands:
 * - a transaction owner (`entry`, `prepend`, `explicit`) while its transaction is open,
 * - otherwise `follow` (steady state; the bottom-follow mode machine additionally gates whether
 *   follow actually writes — that mode gating composes externally and stays the only follow gate),
 * - `idle` never writes.
 *
 * Policy: `entry` and `prepend` are mutually exclusive and cannot preempt anything;
 * `explicit` (user actions) preempts and closes any open transaction.
 */

export type TranscriptViewportTransactionOwner = 'entry' | 'prepend' | 'explicit';

export type TranscriptViewportTransactionOutcome =
    | 'confirmed'
    | 'deadline'
    | 'preempted'
    | 'mvcp-preserved'
    | 'fallback-restored'
    | 'abandoned-layout-timeout'
    | 'abandoned-identity'
    | 'abandoned-user-scroll';

export type TranscriptViewportOpenTransactionResult =
    | Readonly<{ opened: true }>
    | Readonly<{ opened: false; activeOwner: TranscriptViewportOwner }>;

export type TranscriptViewportCloseTransactionResult =
    | Readonly<{ closed: true; owner: TranscriptViewportTransactionOwner; outcome: TranscriptViewportTransactionOutcome }>
    | Readonly<{ closed: false; activeOwner: TranscriptViewportOwner }>;

export type TranscriptViewportPreemptResult =
    | Readonly<{ opened: true; preemptedOwner: TranscriptViewportTransactionOwner | null }>
    | Readonly<{ opened: false; preemptedOwner: null; activeOwner: TranscriptViewportOwner }>;

export type TranscriptViewportOwnership = Readonly<{
    openTransaction: (owner: TranscriptViewportTransactionOwner) => TranscriptViewportOpenTransactionResult;
    closeTransaction: (
        owner: TranscriptViewportTransactionOwner,
        outcome: TranscriptViewportTransactionOutcome,
    ) => TranscriptViewportCloseTransactionResult;
    preempt: (byOwner: TranscriptViewportTransactionOwner) => TranscriptViewportPreemptResult;
    canWrite: (owner: TranscriptViewportOwner) => boolean;
    activeOwner: () => TranscriptViewportOwner;
}>;

export function createTranscriptViewportOwnership(): TranscriptViewportOwnership {
    let openTransactionOwner: TranscriptViewportTransactionOwner | null = null;

    const activeOwner = (): TranscriptViewportOwner => openTransactionOwner ?? 'follow';

    const openTransaction = (
        owner: TranscriptViewportTransactionOwner,
    ): TranscriptViewportOpenTransactionResult => {
        if (openTransactionOwner !== null) {
            return { opened: false, activeOwner: openTransactionOwner };
        }
        openTransactionOwner = owner;
        return { opened: true };
    };

    const closeTransaction = (
        owner: TranscriptViewportTransactionOwner,
        outcome: TranscriptViewportTransactionOutcome,
    ): TranscriptViewportCloseTransactionResult => {
        if (openTransactionOwner !== owner) {
            return { closed: false, activeOwner: activeOwner() };
        }
        openTransactionOwner = null;
        return { closed: true, owner, outcome };
    };

    const preempt = (byOwner: TranscriptViewportTransactionOwner): TranscriptViewportPreemptResult => {
        if (byOwner === 'explicit') {
            const preemptedOwner = openTransactionOwner;
            openTransactionOwner = 'explicit';
            return { opened: true, preemptedOwner };
        }
        if (openTransactionOwner !== null) {
            return { opened: false, preemptedOwner: null, activeOwner: openTransactionOwner };
        }
        openTransactionOwner = byOwner;
        return { opened: true, preemptedOwner: null };
    };

    const canWrite = (owner: TranscriptViewportOwner): boolean => {
        if (owner === 'idle') return false;
        return owner === activeOwner();
    };

    return {
        openTransaction,
        closeTransaction,
        preempt,
        canWrite,
        activeOwner,
    };
}
