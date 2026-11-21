import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionPublicLinkCard } from '@/components/sessions/collaboration/SessionPublicLinkSection';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { useDocumentPublicLinkController } from './useDocumentPublicLinkController';
import type { DocumentShareKind } from './documentShareAdapter';
import { describePublicLinkNetworkConsequence } from '@/components/sharing/PublicLinkNetworkConfirmation';

const styles = StyleSheet.create(theme => ({
    audit: { marginTop: theme.space.s8, gap: theme.space.s8 },
    visit: { ...Typography.mono(), ...ITEM_SUBTITLE_TEXT_METRICS.compact, color: theme.colors.text.secondary },
}));

/** Presentation only: bearer custody survives this row collapsing in the sheet's controller. */
export function DocumentPublicLinkSection(props: Readonly<{
    link: ReturnType<typeof useDocumentPublicLinkController>; idPrefix: string; kind?: DocumentShareKind;
}>): React.ReactElement {
    const { link, idPrefix } = props;
    const visual = props.kind === 'html' || props.kind === 'widget-definition.v1';
    // Only a visual can reach the network; any other document has no network consequence to state or switch off.
    const networkConsequenceStatus = !visual ? undefined : link.loading ? 'loading'
        : link.error || !link.networkPolicy ? 'unavailable' : 'ready';
    const networkPolicyLabel = !visual ? undefined : networkConsequenceStatus === 'ready'
        ? describePublicLinkNetworkConsequence({ visualCount: 1,
            networkVisualCount: link.networkPolicy?.network !== 'none' ? 1 : 0,
            policies: link.networkPolicy && link.networkPolicy.network !== 'none' ? [link.networkPolicy] : [] })
        : t('session.collaboration.pane.linkNetworkUnknown');
    type AccessLog = Awaited<ReturnType<typeof link.listAccessLog>>['accessLog'];
    const [audit, setAudit] = React.useState<Readonly<{ rows: AccessLog | null; loading: boolean; failure?: unknown; failed: boolean }>>({
        rows: null, loading: false, failed: false,
    });
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const readAudit = async () => {
        if (audit.loading || link.readOnly) return;
        setAudit(previous => ({ ...previous, loading: true, failed: false, failure: undefined }));
        try {
            const result = await link.listAccessLog();
            if (mounted.current) setAudit({ rows: result.accessLog, loading: false, failed: false });
        } catch (failure) {
            if (mounted.current) setAudit(previous => ({ ...previous, loading: false, failed: true, failure }));
        }
    };
    const auditIssue = audit.failed ? link.presentFailure(audit.failure) : null;
    return <View testID={`${idPrefix}document-share-public-link-controls`}>
        <SessionPublicLinkCard key={link.scopeKey} testID={`${idPrefix}document-share-public-link-card`}
            presentation="inline"
            configurationScope={link.configurationScope}
            publicShare={link.publication} shareUrl={link.shareUrl} serverUrl={null}
            description={t(props.kind === 'workflow-definition.v1' ? 'shareSheet.publicLink.workflowDescription' : 'shareSheet.publicLink.description')}
            grantsLabel={t(props.kind === 'workflow-definition.v1' ? 'shareSheet.publicLink.workflowGrants' : 'shareSheet.publicLink.grants')}
            loading={link.loading} loaded={link.loaded} failed={link.error} readFailure={link.issue}
            presentFailure={link.presentFailure} readOnly={link.readOnly}
            pendingApproval={link.pendingApproval} onRetry={link.reload} onOpenPendingApproval={link.openPendingApproval}
            networkPolicyLabel={networkPolicyLabel} networkConsequenceStatus={networkConsequenceStatus}
            onCreate={link.create} onDelete={link.remove}
            linkControl={<ToolbarButton testID={`${idPrefix}document-share-public-link-audit`}
                label={t('shareSheet.publicLink.audit')} disabled={link.readOnly || audit.loading} busy={audit.loading}
                onPress={() => { void readAudit(); }} />} />
        {link.publication && (audit.failed || audit.rows) ? <View style={styles.audit}>
            {audit.failed ? <SurfaceStateCard size="line" kind="error" title={t('session.collaboration.pane.linkLoadFailed')}
                reason={auditIssue?.message} diagnosticCode={auditIssue?.code}
                action={{ label: t('common.retry'), onPress: readAudit }} /> : null}
            {audit.rows?.length === 0 ? <SurfaceStateCard size="line" kind="empty" title={t('shareSheet.publicLink.auditEmpty')} /> : null}
            {audit.rows?.map(row => <Text key={row.id} testID={`${idPrefix}document-share-public-link-visit:${row.id}`} style={styles.visit}>
                {[new Date(row.accessedAt).toLocaleString(), row.ipAddress, row.userAgent].filter(Boolean).join(' · ')}
            </Text>)}
        </View> : null}
    </View>;
}
