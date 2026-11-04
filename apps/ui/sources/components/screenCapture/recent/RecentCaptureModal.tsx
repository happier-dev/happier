import * as React from 'react';

import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { readRecentCapture } from '@/desktop/capture/nativeCapture';
import type { AttachmentFilePickerProps } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { t } from '@/text';

import { RecentCaptureGrid } from './RecentCaptureGrid';
import type { RecentCaptureConsumer } from './useRecentCaptures';

const GRID_HEIGHT = 420;

function RecentCaptureModal(props: CustomModalInjectedProps & Readonly<{ onChoose: RecentCaptureConsumer }>) {
    const chrome = React.useMemo(() => ({ kind: 'card' as const, title: t('screenCapture.window.attachRecent'), testID: 'recent-captures-modal' }), []);
    useModalCardChrome(props.setChrome, chrome);
    return (
        <RecentCaptureGrid
            maxHeight={GRID_HEIGHT}
            onChoose={async (entry) => { await props.onChoose(entry); props.onClose(); }}
        />
    );
}

/** One picker for composer attachment and Capture-window recovery. */
export function showRecentCapturePicker(onChoose: RecentCaptureConsumer): void {
    Modal.show({
        component: RecentCaptureModal,
        props: { onChoose },
    });
}

/** The composer's already-scoped picked-file intake owns the tray and inline references. */
export function showRecentCaptureModal(onAttachmentsPicked: AttachmentFilePickerProps['onAttachmentsPicked']): void {
    showRecentCapturePicker(async (entry) => {
        const bytes = await readRecentCapture(entry.path);
        const { mimeType } = resolveFileViewerKind({ path: entry.name, head: bytes });
        const file = new File([bytes as BlobPart], entry.name, { type: mimeType });
        onAttachmentsPicked([{ kind: 'web', file }]);
    });
}
