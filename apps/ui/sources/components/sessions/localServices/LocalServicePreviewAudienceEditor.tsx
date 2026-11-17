import { SHARE_SHEET_HOST } from '@/components/sharing/shareSheetHost';
import * as React from 'react';

import { ShareSheet } from '@happier-dev/plugin-ui/components';
import type { ShareSheetAdapter, ShareUiReason } from '@/components/sharing/shareSheetTypes';
import { useAudienceDraftShareController, type ShareAudienceDraft } from '@/components/sharing/useAudienceDraftShareController';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/**
 * Who a people share of one running Service admits, on the one share sheet's people/Team/Group
 * directory. The exposure sheet owns the draft and the single create; the server re-decides
 * eligibility at create and membership at each viewer's admission.
 */
export function LocalServicePreviewAudienceEditor(props: Readonly<{
    scope: ServerAccountScope;
    draft: ShareAudienceDraft;
    onChange: (draft: ShareAudienceDraft) => void;
    testID: string;
}>): React.ReactElement {
    const lockReason = React.useMemo<ShareUiReason>(() => ({
        code: 'service_preview_single_level', message: t('localServices.publicPreview.consequenceReachPeople'),
    }), []);
    const controller = useAudienceDraftShareController({ scope: props.scope, draft: props.draft,
        onChange: props.onChange, disabled: false, lockReason });
    const adapter = React.useMemo<ShareSheetAdapter>(() => ({
        namespace: 'service-preview-audience',
        title: t('localServices.publicPreview.audienceLabel'),
        levels: { view: { label: t('localServices.publicPreview.canOpen') } },
        showsLevelLock: () => true,
    }), []);
    return <ShareSheet host={SHARE_SHEET_HOST} key={`${props.scope.serverId}:${props.scope.accountId}`} model={controller.model}
        actions={controller.actions} adapter={adapter} presentation="inline" testID={props.testID} />;
}
