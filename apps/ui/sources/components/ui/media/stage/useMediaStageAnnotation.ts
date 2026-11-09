import * as React from 'react';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import type { ImageAnnotationSource } from '../annotation/annotatorStore';
import type { MediaStageItem } from './mediaStageItems';
import { copyAnnotatedPicture } from '@/components/sessions/composer/copyAnnotatedPicture';
import { readComposerPictureSource } from '@/components/sessions/composer/replaceComposerPicture';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';

export type StageAnnotationSession = Readonly<{ source: ImageAnnotationSource; initial: ImageMarksDocumentV1 }>;

/** The chooser hands an address; the draft owner writes under that Home's bound Account. */
async function exactSessionTarget(address: SessionAddress): Promise<ExactSessionMachineTargetIdentity | null> {
    const resolution = await resolveServerCredentialAccountScope(address.serverId);
    return resolution.kind === 'bound' ? { ...address, accountId: resolution.scope.accountId } : null;
}

/** Stage mode owns cancellation and original acquisition; canvas/history stay with the annotator. */
export function useMediaStageAnnotation(item: MediaStageItem) {
    const [session, setSession] = React.useState<StageAnnotationSession | null>(null);
    const [confirmDiscard, setConfirmDiscard] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const [pending, setPending] = React.useState(false);
    const [copyDocument, setCopyDocument] = React.useState<ImageMarksDocumentV1 | null>(null);
    const entering = React.useRef(false);
    const enter = async (loaded: Omit<ImageAnnotationSource, 'scale'> & Readonly<{ scale?: number }>) => {
        if (entering.current || (item.kind !== 'image' && item.kind !== 'svg')) return;
        entering.current = true;
        setPending(true); setFailure(null);
        try {
            const source = item.edit?.original ? await item.edit.original() : await readComposerPictureSource({ kind: 'preview', source: loaded });
            if (!source) { setFailure('annotation.targetUnavailable'); return; }
            const initial = item.edit?.document ?? { v: 1 as const, image: { width: source.width, height: source.height, scale: source.scale }, marks: [] };
            setSession({ source, initial }); setConfirmDiscard(false);
        } finally { entering.current = false; setPending(false); }
    };
    const discard = () => { setSession(null); setConfirmDiscard(false); setFailure(null); setCopyDocument(null); };
    const cancel = (document: ImageMarksDocumentV1) => {
        if (confirmDiscard) { setConfirmDiscard(false); return; }
        if (session && document !== session.initial) setConfirmDiscard(true);
        else discard();
    };
    const done = async (document: ImageMarksDocumentV1) => {
        if (!session || entering.current) return false;
        if (!item.edit) { setCopyDocument(document); return false; }
        entering.current = true;
        setPending(true); setFailure(null);
        try {
            const result = await item.edit.commit({ source: session.source, document });
            if (!result.ok) { setFailure(result.reason); return false; }
            discard(); return true;
        } finally { entering.current = false; setPending(false); }
    };
    const copyToSession = async (target: SessionAddress | ExactSessionMachineTargetIdentity) => {
        if (!session || !copyDocument || entering.current) return false;
        entering.current = true; setPending(true); setFailure(null);
        try {
            const sessionTarget = 'accountId' in target ? target : await exactSessionTarget(target);
            if (!sessionTarget) { setFailure('annotation.targetUnavailable'); return false; }
            const result = await copyAnnotatedPicture({ source: session.source, document: copyDocument, name: item.title, sessionTarget });
            if (!result.ok) { setFailure(result.reason); return false; }
            discard(); return true;
        } finally { entering.current = false; setPending(false); }
    };
    return { session, mode: session ? 'annotate' as const : 'view' as const, confirmDiscard, failure, pending,
        enter, done, cancel, discard, keepEditing: () => setConfirmDiscard(false),
        choosingSession: copyDocument !== null, copyToSession, cancelCopy: () => setCopyDocument(null), targetSession: item.targetSession };
}
