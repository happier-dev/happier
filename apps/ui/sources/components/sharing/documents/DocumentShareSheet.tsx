import * as React from 'react';
import { getArtifactKindPolicyV1 } from '@happier-dev/protocol';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { ShareSheet } from '../ShareSheet';
import type { ShareSheetActions, ShareSheetModel, ShareSheetPresentation } from '../shareSheetTypes';
import { createDocumentShareAdapter, type DocumentShareKind } from './documentShareAdapter';
import { useDocumentShareController } from './useDocumentShareController';
import { useDocumentPublicLinkController } from './useDocumentPublicLinkController';
import { DocumentPublicLinkSection } from './DocumentPublicLinkSection';

export type DocumentShareSheetProps = Readonly<{
    artifactId: string;
    kind: DocumentShareKind;
    /** The document's in-app route for Copy link. */
    linkPath?: string;
    /** The host's existing copy hand-off (for example a workflow's JSON export). */
    onSendCopy?: () => void;
    presentation?: ShareSheetPresentation;
    onRequestClose?: () => void;
    testID?: string;
}>;

const DEFAULT_TEST_ID = 'document-share-editor';
const styles = StyleSheet.create(theme => ({
    publicLinkState: { flexDirection: 'row', alignItems: 'center', gap: PAGE_LIST_METRICS.groupHeadingGapPx },
    secondary: { color: theme.colors.text.secondary },
}));

function ScopedDocumentShareSheet(props: DocumentShareSheetProps & Readonly<{ scope: ServerAccountScope }>): React.ReactElement {
    const controller = useDocumentShareController({ artifactId: props.artifactId, scope: props.scope });
    const { theme } = useUnistyles();
    const publicLinkEnabled = useFeatureEnabled('sharing.public', { scopeKind: 'spawn', serverId: props.scope.serverId });
    const canManagePublicLink = publicLinkEnabled && getArtifactKindPolicyV1(props.kind).publicLinkAllowed && controller.model.owner !== null
        && controller.model.editable && !controller.loading && !controller.issue && !controller.model.stale;
    const publicLink = useDocumentPublicLinkController({ artifactId: props.artifactId, scope: props.scope,
        enabled: canManagePublicLink, canManage: canManagePublicLink });
    const publicLinkState = publicLink.error ? t('common.error')
        : !publicLink.loaded ? t('common.loading') : t(publicLink.publication ? 'common.on' : 'common.off');
    const baseAdapter = createDocumentShareAdapter({
        artifactId: props.artifactId,
        kind: props.kind,
        grants: controller.grants,
        ...(props.linkPath ? { linkPath: props.linkPath } : {}),
        ...(props.onSendCopy ? { sendCopy: props.onSendCopy } : {}),
        loading: controller.loading,
        ...(controller.issue ? { issue: controller.issue } : {}),
        ...(controller.notice ? { notice: controller.notice } : {}),
        readOnly: !controller.loading && !controller.issue && !controller.model.editable,
        retryContent: controller.retryContent,
    });
    const adapter = {
        ...baseAdapter,
        sections: (context: Parameters<NonNullable<typeof baseAdapter.sections>>[0]) => ({
            ...baseAdapter.sections?.(context),
            ...(canManagePublicLink ? { afterAccess: [{ kind: 'static' as const, id: 'public-link', options: [{
                id: 'public-link', testID: `${context.idPrefix}document-share-public-link`, label: t('session.sharing.publicLink'),
                accessibilityLabel: `${t('session.sharing.publicLink')}, ${publicLinkState}`,
                rightAccessory: () => <View style={styles.publicLinkState}>
                    <Text style={styles.secondary}>{publicLinkState}</Text>
                    <Icon name="caret-right" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                </View>,
                onSelect: () => context.onExpand('public-link'),
                expandedContent: () => <DocumentPublicLinkSection
                    key={`${publicLink.publication?.id ?? 'off'}:${publicLink.publication?.updatedAt ?? ''}`}
                    link={publicLink} idPrefix={context.idPrefix} />,
            }] }] } : {}),
        }),
    };
    return <ShareSheet model={controller.model} actions={controller.actions} adapter={adapter}
        presentation={props.presentation ?? 'full'} onRequestClose={props.onRequestClose} testID={props.testID ?? DEFAULT_TEST_ID} />;
}

const noop = () => {};
const UNSCOPED_ACTIONS: ShareSheetActions = {
    setQuery: noop, retryDirectory: noop, loadMore: noop, addPrincipal: noop, retryMutation: noop,
    setAccessLevel: noop, requestRemove: noop, confirmRemove: noop, cancelRemove: noop, explain: noop,
};
const UNSCOPED_MODEL: ShareSheetModel = {
    revision: 0, editable: false, stale: false, owner: null, grants: [], directory: { query: '', sections: [] },
};

/**
 * Share any ordinary Account Artifact (a document, prompt, board, workflow, role or launch profile): the one share sheet with the documents adapter over
 * the Artifact grant Actions. Hosts mount it from their own share slot (see `showDocumentShareSheet`).
 */
export function DocumentShareSheet(props: DocumentShareSheetProps): React.ReactElement {
    const scope = useActiveServerAccountScope();
    if (scope) return <ScopedDocumentShareSheet key={`${scope.serverId}:${scope.accountId}:${props.artifactId}`} {...props} scope={scope} />;
    const adapter = createDocumentShareAdapter({
        artifactId: props.artifactId,
        kind: props.kind, grants: [], loading: false, readOnly: false, retryContent: noop,
        issue: { code: 'not_authenticated', message: t('shareSheet.documents.errors.unavailable'), retryable: false },
    });
    return <ShareSheet model={UNSCOPED_MODEL} actions={UNSCOPED_ACTIONS} adapter={adapter}
        presentation={props.presentation ?? 'full'} onRequestClose={props.onRequestClose} testID={props.testID ?? DEFAULT_TEST_ID} />;
}
