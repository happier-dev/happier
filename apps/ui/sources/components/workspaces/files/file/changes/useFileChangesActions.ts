import * as React from 'react';
import type { ScmComparison } from '@happier-dev/protocol/scm';

import { Modal } from '@/modal';
import { discardChange, type DiscardChangeParams, type DiscardChangeResult } from '@/components/sessions/files/review/discardChange';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { FileMenuContext } from '../fileMenus';
import { resolveFileChangesRestoreIntent } from './fileChangesRestore';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { resolveCheckpointRollbackEvidence } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { executeTranscriptRollbackAction } from '@/components/sessions/transcript/transcriptRollbackActionRunner';
import { t } from '@/text';

/** Reuse the transcript's exact checkpoint admission and dialog; no nearest-turn fallback. */
export function useFileChangesRollback(address: SessionAddress | null, rootPath: string) {
    const derived = useDerivedSessionChangeSet(address, rootPath);
    return React.useCallback((turnId: string) => {
        if (!address) return;
        const evidence = resolveCheckpointRollbackEvidence({ sessionId: address.sessionId, turnId,
            turnChangeSets: derived.turnChangeSets, conversationRollbackSupported: false });
        if (!evidence || evidence.cwd !== rootPath) return;
        const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => address.serverId });
        void executeTranscriptRollbackAction({ executor, sessionId: address.sessionId, checkpointCodeRollback: evidence })
            .catch((error: unknown) => Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError')));
    }, [address?.serverId, address?.sessionId, derived.turnChangeSets, rootPath]);
}

/** Menu behavior only; PAGE supplies the dirty-editor and whole-turn-dialog owners. */
export function useFileChangesActions(input: Omit<DiscardChangeParams, 'entry'> & Readonly<{
    filePath: string;
    selector: SessionScmReviewComparison;
    comparison: ScmComparison | null;
    /** Whether the shown scope has changes for this file; an unchanged file offers no restore. */
    changed: boolean;
    expectedHash?: string | null;
    /** Selected deletion; the canonical mutation result determines whether Undo exists. */
    deleted?: boolean;
    hasUnsavedEdits: () => boolean;
    onReplacedUnsavedEdits: () => void;
    confirmUnsaved: Readonly<{ title: string; message?: string; confirmText?: string; cancelText?: string }>;
    restoreBeforeTurnTitle?: string;
    /** Offers the existing CheckpointCodeRollbackDialog; never executes rollback itself. */
    offerWholeTurnRollback?: (turnId: string) => void;
}>) {
    const [result, setResult] = React.useState<DiscardChangeResult | null>(null);
    const intent = resolveFileChangesRestoreIntent({ path: input.filePath, selector: input.selector,
        comparison: input.comparison, sessionId: input.sessionTarget?.sessionId, expectedHash: input.expectedHash, changed: input.changed });
    const restore = async () => {
        const selected = input;
        const entry = intent.entry;
        if (!entry) return;
        const dirty = selected.hasUnsavedEdits();
        if (dirty && !await Modal.confirm(selected.confirmUnsaved.title, selected.confirmUnsaved.message,
            { confirmText: selected.confirmUnsaved.confirmText, cancelText: selected.confirmUnsaved.cancelText, destructive: true })) return;
        // Captured entries are repository-relative, even when the Session started below that root.
        const target = selected.comparison
            ? { ...selected.target, rootPath: selected.comparison.repository.rootPath }
            : selected.target;
        const outcome = await discardChange({ target, entry, messages: selected.messages,
            readCurrentText: selected.readCurrentText, refresh: selected.refresh, options: selected.options, sessionTarget: selected.sessionTarget });
        setResult(outcome);
        if (outcome.ok) {
            if (dirty && outcome.fileReplaced) selected.onReplacedUnsavedEdits();
        } else if ((outcome.reason === 'unsupported' || outcome.reason === 'moved_on')
            && selected.selector.kind === 'turnCheckpoint' && selected.selector.turnId) {
            selected.offerWholeTurnRollback?.(selected.selector.turnId);
        }
    };
    const changes: NonNullable<FileMenuContext['changes']> = intent.entry ? {
        discardAll: restore,
        ...(intent.restoreBeforeTurn ? { restoreBeforeTurn: restore,
            ...(input.restoreBeforeTurnTitle ? { restoreBeforeTurnTitle: input.restoreBeforeTurnTitle } : {}) } : {}),
    } : {};
    return { changes, result, restoreDeleted: input.deleted && intent.entry ? restore : undefined };
}
