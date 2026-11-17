import { SHARE_SHEET_HOST } from '@/components/sharing/shareSheetHost';
import * as React from 'react';
import type { SavedSecretCatalogAudienceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { ShareSheet } from '@happier-dev/plugin-ui/components';
import type { ShareLevelPresentation, ShareSheetAdapter, ShareUiReason } from '../shareSheetTypes';
import type { SavedSecretGrantDraft } from './savedSecretGrantDraft';
import { useSavedSecretShareController } from './useSavedSecretShareController';

/**
 * A Saved Secret grant gives recipients the value, including the ability to see and copy it.
 * Future access can be stopped, but a disclosed copy cannot be recalled. Management stays owner-only.
 * The brokered "Let them use it" choice belongs to Team credentials, not Saved Secrets.
 */
function createSavedSecretShareAdapter(notice: ShareUiReason | undefined): ShareSheetAdapter {
    // What a grant gives is said once, by the Sharing section above the sheet (and the disclosure before
    // the first share), so the one level carries no second help paragraph under the list.
    const canUse: ShareLevelPresentation = { label: t('shareSheet.secrets.levels.canUse') };
    // Every row is locked at `view`; the other two levels are never offered, so they carry no help.
    const unused: ShareLevelPresentation = { label: canUse.label };
    return {
        namespace: 'saved-secret-access',
        title: t('secrets.catalog.actions.manageAccess'),
        levels: { view: canUse, edit: unused, admin: unused },
        showsLevelLock: () => true,
        sections: () => notice
            ? { trailing: [{ kind: 'static', id: 'status', options: [{ id: 'notice', label: notice.message, disabled: true }] }] }
            : {},
    };
}

function ScopedSavedSecretShareSheet(props: SavedSecretShareSheetProps): React.ReactElement {
    const controller = useSavedSecretShareController({
        scope: props.scope,
        draft: props.draft,
        onChange: props.onChange,
        disabled: props.disabled ?? false,
        ...(props.retainedAudience ? { retainedAudience: props.retainedAudience } : {}),
    });
    const adapter = React.useMemo(() => createSavedSecretShareAdapter(controller.notice), [controller.notice]);
    return <ShareSheet host={SHARE_SHEET_HOST} model={controller.model} actions={controller.actions} adapter={adapter}
        presentation="inline" testID="saved-secret-access-editor" />;
}

export type SavedSecretShareSheetProps = Readonly<{
    scope: ServerAccountScope;
    draft: SavedSecretGrantDraft;
    onChange: (draft: SavedSecretGrantDraft) => void;
    disabled?: boolean;
    /** The audience the Home holds now; it names the people already listed. */
    retainedAudience?: SavedSecretCatalogAudienceV1;
}>;

/**
 * Who a Saved Secret reaches, on the one share sheet, inside the host's create or access editor.
 * The host owns the draft and its single write; this only edits the list.
 */
export function SavedSecretShareSheet(props: SavedSecretShareSheetProps): React.ReactElement {
    // Recipients are one Home's identities: another Home or Account is a different directory.
    return <ScopedSavedSecretShareSheet key={`${props.scope.serverId}:${props.scope.accountId}`} {...props} />;
}
