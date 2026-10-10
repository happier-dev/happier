import * as React from 'react';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { ShareSheet } from '@/components/sharing/ShareSheet';
import { createSessionShareSheetAdapter, isSessionAccessEditable } from './sessionShareSheetAdapter';
import type { SessionAccessEditorProps } from './sessionAccessEditorTypes';

/** The session share sheet: the one `ShareSheet` with the session adapter. */
export function SessionAccessEditor(props: SessionAccessEditorProps): React.ReactElement {
    const { model, actions, presentation, onRequestClose, testID = 'session-access-editor' } = props;
    // Encrypted-access preparation is slow, asynchronous and invisible to a screen reader once the
    // summary row has been read. The projector already decides what a material state is, so this
    // only reports the moment one is *reached*: a committed count tick and a later recipient page
    // keep the same key and say nothing.
    const encryptionStatusKey = model.encryption?.statusKey ?? null;
    const encryptionAnnouncement = model.encryption?.announcement;
    const announcedEncryptionStatus = React.useRef(encryptionStatusKey);
    React.useEffect(() => {
        const previous = announcedEncryptionStatus.current;
        announcedEncryptionStatus.current = encryptionStatusKey;
        if (previous === null || previous === encryptionStatusKey || !encryptionAnnouncement) return;
        announceAccessibilityMessage(encryptionAnnouncement);
    }, [encryptionAnnouncement, encryptionStatusKey]);
    const adapter = createSessionShareSheetAdapter({
        model, actions,
        ...(props.linkPath ? { linkPath: props.linkPath } : {}),
        responsibleAccountId: props.responsibleAccountId,
        publicLink: props.publicLink,
        ...(props.onOpenFullSurface ? { onOpenFullSurface: props.onOpenFullSurface } : {}),
    });
    const sheetModel = {
        revision: model.revision,
        editable: isSessionAccessEditable(model),
        stale: model.content.phase === 'error' && model.content.hasLastAcknowledgedSnapshot,
        owner: model.owner,
        grants: model.grants,
        directory: model.directory,
    };
    return <ShareSheet model={sheetModel} actions={actions} adapter={adapter} presentation={presentation}
        onRequestClose={onRequestClose} openRowRequest={props.openRowRequest} testID={testID} />;
}
