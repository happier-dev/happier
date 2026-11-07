import * as React from 'react';
import { Platform, View } from 'react-native';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { MarkdownView, type MarkdownSelectionAction } from '@/components/markdown/MarkdownView';
import { Modal } from '@/modal';
import { t } from '@/text';
import { TranscriptAnnotationPopover } from './TranscriptAnnotationPopover';
import { readNativeTranscriptPassageQuote } from './transcriptPassageSelection';
import { annotateTranscriptPassage, captureTranscriptPassage, quoteTranscriptPassage, type CapturedTranscriptPassage } from './transcriptPassageActions';

/** Adds passage actions only around the completed prose body, never row chrome or attachments. */
export function TranscriptPassageMarkdownView(props: React.ComponentProps<typeof MarkdownView> & Readonly<{
    passageSource: SessionMessageRefV1 | null;
    destinationSessionId: string;
}>) {
    const { passageSource, destinationSessionId, ...markdownProps } = props;
    const [annotation, setAnnotation] = React.useState<CapturedTranscriptPassage | null>(null);
    const basis = React.useRef(props);
    basis.current = props;
    const selectionActions = React.useMemo<readonly MarkdownSelectionAction[] | undefined>(() => {
        if (!passageSource || Platform.OS === 'web') return undefined;
        return (['quote', 'annotate'] as const).map((action) => ({ label: t(`transcriptPassage.${action}`),
            onPress: (_block, selection) => {
                // Markdown owns normalized block coordinates. Currentness belongs to the
                // unchanged whole input and its source/destination, not a slice of raw Markdown.
                if (basis.current.passageSource !== passageSource || basis.current.destinationSessionId !== destinationSessionId
                    || basis.current.markdown !== props.markdown) return;
                const quote = readNativeTranscriptPassageQuote(selection);
                const passage = quote ? captureTranscriptPassage(quote, passageSource,
                    { kind: 'session', sessionId: destinationSessionId }) : null;
                if (!passage) { Modal.alert(t('common.error'), t('transcriptPassage.quoteError')); return; }
                if (action === 'annotate') setAnnotation(passage);
                else void quoteTranscriptPassage(passage).then((ok) => {
                    if (!ok) Modal.alert(t('common.error'), t('transcriptPassage.quoteError'));
                });
            } }));
    }, [destinationSessionId, passageSource, props.markdown]);
    const body = <MarkdownView {...markdownProps} selectionActions={selectionActions} />;
    return <>
        {Platform.OS === 'web'
            ? <View {...(passageSource ? { dataSet: { happierTranscriptPassage: JSON.stringify(passageSource) } } : {})}>{body}</View> : body}
        {annotation ? <TranscriptAnnotationPopover quote={annotation.quote}
            onSave={(note) => {
                const current = basis.current.passageSource;
                if (!current || current.messageId !== annotation.source.messageId
                    || current.session.serverId !== annotation.source.session.serverId
                    || current.session.sessionId !== annotation.source.session.sessionId
                    || basis.current.destinationSessionId !== annotation.destination.sessionId) return Promise.resolve(false);
                return annotateTranscriptPassage(annotation, note);
            }} onCancel={() => setAnnotation(null)} /> : null}
    </>;
}
