import * as React from 'react';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import { useImageAnnotator } from '@/components/ui/media/annotation/useImageAnnotator';
import type { AnnotationChangeCause, ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import { readRecordingFrameDocument, reduceRecordingDocument,
    type RecordingDocument, type RecordingOperation } from './recordingDocument';

export type RecordingAuthoringInput = Readonly<{
    document: RecordingDocument;
    onDocumentChange: (document: RecordingDocument, previous: RecordingDocument, operations: readonly RecordingOperation[]) => void | Promise<void>;
}>;
export type RecordingAuthoring = Readonly<{
    document: RecordingDocument;
    commit: (operations: readonly RecordingOperation[]) => Promise<RecordingDocument>;
    commitFrameDocument: (sourceTimeMs: number, document: ImageMarksDocumentV1, cause: AnnotationChangeCause) => Promise<RecordingDocument>;
    setIncludeVideo: (mode: RecordingDocument['includeVideo']) => Promise<RecordingDocument>;
    resolveWarning: (include: boolean) => Promise<RecordingDocument>;
    onInput: () => Promise<RecordingDocument>;
    setWindowTextIncluded: (included: boolean) => Promise<RecordingDocument>;
    resolveWindowTextWarning: (include: boolean) => Promise<RecordingDocument>;
}>;

/** The controlling P3 authoring session owns the document and its writes. */
export function useRecordingAuthoring(input: RecordingAuthoringInput): RecordingAuthoring {
    const current = React.useRef(input);
    current.current = input;
    const commit = React.useCallback(async (operations: readonly RecordingOperation[]): Promise<RecordingDocument> => {
        const owner = current.current;
        const next = operations.reduce(reduceRecordingDocument, owner.document);
        if (next !== owner.document) await owner.onDocumentChange(next, owner.document, operations);
        return next;
    }, []);
    const commitFrameDocument = React.useCallback((sourceTimeMs: number, document: ImageMarksDocumentV1, cause: AnnotationChangeCause) =>
        commit([{ kind: 'frame.document', sourceTimeMs, document, cause }]), [commit]);
    return { document: input.document, commit, commitFrameDocument,
        setIncludeVideo: (mode: RecordingDocument['includeVideo']) => commit([{ kind: 'includeVideo.set', mode }]),
        resolveWarning: (include: boolean) => commit([{ kind: 'disclosure.warning', include }]),
        onInput: () => commit([{ kind: 'disclosure.input' }, { kind: 'windowText.input' }]),
        setWindowTextIncluded: (included: boolean) => commit([{ kind: 'windowText.set', included }]),
        resolveWindowTextWarning: (include: boolean) => commit([{ kind: 'windowText.warning', include }]) };
}

/** Mount in a frame leaf keyed by sourceCaptureRef/sourceTimeMs, matching P2's annotation lifetime. */
export function useRecordingFrameAnnotator(input: Readonly<{
    authoring: RecordingAuthoring;
    sourceTimeMs: number;
    source: ImageAnnotationSource;
    onCommitError: (error: unknown) => void;
}>): Readonly<{ annotator: ReturnType<typeof useImageAnnotator>; flush: () => Promise<void>; retry: () => Promise<void> }> {
    const current = React.useRef(input);
    current.current = input;
    const pending = React.useRef<Promise<void>>(Promise.resolve());
    const phaseRef = React.useRef<'clean' | 'pending' | 'failed'>('clean');
    const [phase, setPhase] = React.useState(phaseRef.current);
    const commitFrame = React.useCallback((document: ImageMarksDocumentV1, cause: AnnotationChangeCause, retry: boolean) => {
        const owner = current.current;
        const write = owner.authoring.commitFrameDocument(owner.sourceTimeMs, document, cause).then(() => undefined);
        // Writes start immediately. This only keeps flush failed until an explicit Retry settles successfully.
        const completion = retry ? write : Promise.all([pending.current, write]).then(() => undefined);
        pending.current = completion;
        phaseRef.current = 'pending'; setPhase('pending');
        void completion.then(() => {
            if (pending.current === completion) { phaseRef.current = 'clean'; setPhase('clean'); }
        }, () => {
            if (pending.current === completion) { phaseRef.current = 'failed'; setPhase('failed'); }
        });
        void write.catch(error => current.current.onCommitError(error));
        return completion;
    }, []);
    const annotator = useImageAnnotator({ source: input.source,
        initial: readRecordingFrameDocument(input.authoring.document, input.sourceTimeMs) ?? undefined,
        tools: { crop: false }, onDocumentChange: (document, cause) => {
            void commitFrame(document, cause, false);
        } });
    React.useLayoutEffect(() => {
        // A refused local edit is still authoritative work the person must be able to Retry.
        if (phaseRef.current !== 'clean') return;
        const document = readRecordingFrameDocument(input.authoring.document, input.sourceTimeMs)
            ?? { v: 1 as const, image: annotator.store.getState().document.image, marks: [] };
        annotator.receiveDocument(document);
    }, [annotator, input.authoring.document, input.sourceTimeMs, phase]);
    const flush = React.useCallback(() => pending.current, []);
    const retry = React.useCallback(() => {
        if (phaseRef.current === 'pending') return pending.current;
        const state = annotator.store.getState();
        return commitFrame(state.document, state.cause, true);
    }, [annotator, commitFrame]);
    return { annotator, flush, retry };
}
