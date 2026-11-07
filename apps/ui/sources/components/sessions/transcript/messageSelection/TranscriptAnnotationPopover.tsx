import * as React from 'react';
import { Platform } from 'react-native';
import { CONTENT_SIZED_POPOVER_WIDTH, Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { TranscriptAnnotationEditor } from './TranscriptAnnotationEditor';

type Props = React.ComponentProps<typeof TranscriptAnnotationEditor> & Readonly<{ anchor?: Rect | null }>;

/**
 * The note form beside its selection on web (a bottom sheet on a phone-width window), a sheet over
 * the transcript on native. A press outside keeps a typed note open; Escape or Cancel discards it.
 */
export function TranscriptAnnotationPopover(props: Props) {
    const native = Platform.OS !== 'web';
    const draft = React.useRef(props.note ?? '');
    React.useEffect(() => {
        if (!native) return;
        const id = Modal.show({ component: TranscriptAnnotationEditor, props,
            onRequestClose: props.onCancel,
            chrome: { kind: 'card', header: 'none', title: t('transcriptPassage.noteTitle'), phonePresentation: 'sheet' } });
        return () => Modal.hide(id);
    }, [native]);
    if (native || !props.anchor) return null;
    return <Popover open anchor={{ kind: 'rect', coordinateSpace: 'window', rect: {
        left: props.anchor.x, top: props.anchor.y, width: props.anchor.width, height: props.anchor.height } }}
        placement="auto-vertical" minWidth={CONTENT_SIZED_POPOVER_WIDTH.maxPx}
        accessibilityLabel={t('transcriptPassage.noteTitle')} phonePresentation="sheet" sheetHeader="none"
        onRequestClose={() => { if (!draft.current.trim()) props.onCancel(); }}
        portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'start', sizeToContent: true }}>
        {({ maxHeight }) => <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
            <TranscriptAnnotationEditor {...props} onNoteChange={(note) => {
                draft.current = note;
                props.onNoteChange?.(note);
            }} />
        </FloatingOverlay>}
    </Popover>;
}
