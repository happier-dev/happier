import * as React from 'react';
import { buildUiActionDispatchRequestV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { ComposerTransactionResultV1Schema } from '@happier-dev/protocol/plugins/ui/composer';

import type { ExactSessionMachineTargetIdentity } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    executeDesktopActivityOverlayAction,
    watchDesktopActivityOverlaySessionDraft,
} from '../../runtime/desktopActivityOverlayActions';

export type PinnedSessionDraft = Readonly<{
    text: string;
    /** The latest text at event time (a key handler must see the character just typed). */
    textRef: React.RefObject<string>;
    /** Returns whether this writer still belongs to the mounted field. */
    setText: (next: string) => boolean;
    writeError: string | null;
    retry: () => void;
}>;

/**
 * One Session's writes from this field: its owner revision, the write in flight, the newest text not yet
 * written, and the newest text the person typed. It belongs to the qualified Session, not to a render.
 */
type SessionDraftWriter = {
    readonly target: ExactSessionMachineTargetIdentity;
    revision: number | null;
    inFlight: boolean;
    pending: string | null;
    latest: string;
    writeError: string | null;
    notify: (() => void) | null;
};

// Only unsaved/in-flight writers survive a panel unmount. This is the overlay's transient edit
// buffer; the addressed Session draft remains the persisted owner.
const writers = new Map<string, SessionDraftWriter>();

function readSessionKey(target: ExactSessionMachineTargetIdentity): string {
    return JSON.stringify([target.serverId, target.accountId, target.sessionId]);
}

function isBusy(writer: SessionDraftWriter): boolean {
    return writer.inFlight || writer.pending !== null;
}

function drain(writerKey: string, writer: SessionDraftWriter): void {
    const next = writer.pending;
    const revision = writer.revision;
    if (next === null || revision === null || writer.inFlight || writer.writeError !== null) {
        if (!isBusy(writer) && !writer.notify) writers.delete(writerKey);
        return;
    }
    writer.pending = null;
    writer.inFlight = true;
    const { target: address } = writer;
    fireAndForget((async () => {
        try {
            const outcome = await executeDesktopActivityOverlayAction({
                serverId: address.serverId,
                accountId: address.accountId,
                request: buildUiActionDispatchRequestV1({
                    actionId: 'composer.transaction.apply',
                    input: {
                        scope: { serverId: address.serverId, accountId: address.accountId },
                        ref: { kind: 'session', sessionId: address.sessionId },
                        transaction: { expectedRevision: revision, operations: [{ kind: 'text.set', text: next }] },
                    },
                    context: { surface: 'ui', authority: 'present_user' },
                }),
            });
            const parsed = outcome.ok ? ComposerTransactionResultV1Schema.safeParse(outcome.result) : null;
            if (parsed?.success && parsed.data.status === 'applied') {
                writer.revision = Math.max(writer.revision ?? 0, parsed.data.revision);
            } else if (parsed?.success && parsed.data.status === 'conflict') {
                writer.revision = parsed.data.currentRevision;
                // The person's latest text wins over a concurrent edit elsewhere.
                writer.pending ??= next;
            } else {
                writer.pending ??= next;
                writer.writeError = outcome.ok ? 'invalid_action_output' : outcome.errorCode;
            }
        } catch (error) {
            writer.pending ??= next;
            writer.writeError = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code
                : 'draft_write_failed';
        } finally {
            writer.inFlight = false;
            writer.notify?.();
            drain(writerKey, writer);
        }
    })(), { tag: 'DesktopActivityOverlay.pinnedDraft.write' });
}

/**
 * The pinned field is that Session's own draft (N4 M6): it reads through the one addressed watch and
 * writes a revision-bound `text.set` to the same draft owner the window and main composers use, so a
 * Bot's text follows it to its window and switching Bots shows each Bot's own draft.
 *
 * Writes are kept per qualified Session (Home, Account, Session), so a re-render, a switch to another
 * Bot or the panel closing never strands text already typed: keystrokes made while a write is in flight
 * coalesce into the next write for the same Session, and a conflict rebases on the owner's revision.
 */
export function usePinnedSessionDraft(target: ExactSessionMachineTargetIdentity | null): PinnedSessionDraft {
    const [text, setLocalText] = React.useState('');
    const [writeError, setWriteError] = React.useState<string | null>(null);
    const textRef = React.useRef('');
    const currentKeyRef = React.useRef<string | null>(null);
    const key = target ? readSessionKey(target) : null;
    currentKeyRef.current = key;
    const { serverId, accountId, sessionId } = target ?? { serverId: '', accountId: '', sessionId: '' };

    React.useEffect(() => {
        if (!key || !sessionId) {
            textRef.current = '';
            setLocalText('');
            setWriteError(null);
            return;
        }
        const writer = writers.get(key) ?? { target: { serverId, accountId, sessionId }, revision: null, inFlight: false, pending: null, latest: '', writeError: null, notify: null };
        writers.set(key, writer);
        const show = () => {
            if (currentKeyRef.current !== key) return;
            textRef.current = writer.latest;
            setLocalText(writer.latest);
            setWriteError(writer.writeError);
        };
        writer.notify = show;
        // Text typed for this Bot and not yet written stays on screen until the owner has it.
        textRef.current = isBusy(writer) ? writer.latest : '';
        setLocalText(textRef.current);
        setWriteError(writer.writeError);
        const cancellation = new AbortController();
        let stop: (() => Promise<void>) | null = null;
        fireAndForget(watchDesktopActivityOverlaySessionDraft({ serverId, accountId, sessionId }, (snapshot) => {
            if (cancellation.signal.aborted || !snapshot) return;
            writer.revision = Math.max(writer.revision ?? 0, snapshot.revision);
            // A local edit not yet written is newer than the echo of an older revision.
            if (!isBusy(writer)) {
                writer.latest = snapshot.text;
                show();
            }
            drain(key, writer);
        }, { signal: cancellation.signal }).then((dispose) => {
            if (cancellation.signal.aborted) fireAndForget(dispose(), { tag: 'DesktopActivityOverlay.pinnedDraft.unwatch' });
            else stop = dispose;
        }), { tag: 'DesktopActivityOverlay.pinnedDraft.watch' });
        return () => {
            cancellation.abort();
            if (writer.notify === show) writer.notify = null;
            if (stop) fireAndForget(stop(), { tag: 'DesktopActivityOverlay.pinnedDraft.unwatch' });
            if (!isBusy(writer)) writers.delete(key);
        };
    }, [accountId, key, serverId, sessionId]);

    const setText = React.useCallback((next: string) => {
        const writerKey = key;
        const writer = writerKey ? writers.get(writerKey) : undefined;
        if (!writerKey || !writer) return false;
        writer.latest = next;
        writer.pending = next;
        writer.writeError = null;
        const isCurrent = currentKeyRef.current === writerKey && writer.notify !== null;
        writer.notify?.();
        drain(writerKey, writer);
        return isCurrent;
    }, [key]);

    const retry = React.useCallback(() => {
        const writerKey = key;
        const writer = writerKey ? writers.get(writerKey) : undefined;
        if (!writerKey || !writer) return;
        writer.writeError = null;
        writer.notify?.();
        drain(writerKey, writer);
    }, [key]);

    return React.useMemo(() => ({ text, textRef, setText, writeError, retry }), [retry, setText, text, writeError]);
}
