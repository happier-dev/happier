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

const styles = StyleSheet.create(theme => ({
    audit: { marginHorizontal: 12, marginBottom: 12, gap: 8 },
    visit: { ...Typography.mono(), ...ITEM_SUBTITLE_TEXT_METRICS.compact, color: theme.colors.text.secondary },
}));

/** Presentation only: bearer custody survives this row collapsing in the sheet's controller. */
export function DocumentPublicLinkSection(props: Readonly<{
    link: ReturnType<typeof useDocumentPublicLinkController>; idPrefix: string; kind?: DocumentShareKind;
}>): React.ReactElement {
    const { link, idPrefix } = props;
    type AccessLog = Awaited<ReturnType<typeof link.listAccessLog>>['accessLog'];
    const [audit, setAudit] = React.useState<Readonly<{ rows: AccessLog | null; loading: boolean; failed: boolean }>>({
        rows: null, loading: false, failed: false,
    });
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const readAudit = async () => {
        if (audit.loading || link.readOnly) return;
        setAudit(previous => ({ ...previous, loading: true, failed: false }));
        try {
            const result = await link.listAccessLog();
            if (mounted.current) setAudit({ rows: result.accessLog, loading: false, failed: false });
        } catch {
            if (mounted.current) setAudit(previous => ({ ...previous, loading: false, failed: true }));
        }
    };
    return <View testID={`${idPrefix}document-share-public-link-controls`}>
        <SessionPublicLinkCard testID={`${idPrefix}document-share-public-link-card`}
            presentation="inline"
            publicShare={link.publication} shareUrl={link.shareUrl} serverUrl={null}
            description={t(props.kind === 'workflow-definition.v1' ? 'shareSheet.publicLink.workflowDescription' : 'shareSheet.publicLink.description')}
            grantsLabel={t(props.kind === 'workflow-definition.v1' ? 'shareSheet.publicLink.workflowGrants' : 'shareSheet.publicLink.grants')}
            loading={link.loading} loaded={link.loaded} failed={link.error} readOnly={link.readOnly}
            pendingApproval={link.pendingApproval} onRetry={link.reload} onOpenPendingApproval={link.openPendingApproval}
            onCreate={link.create} onDelete={link.remove} />
        {link.publication ? <View style={styles.audit}>
            <ToolbarButton testID={`${idPrefix}document-share-public-link-audit`}
                label={t('shareSheet.publicLink.audit')} disabled={link.readOnly || audit.loading} busy={audit.loading}
                onPress={() => { void readAudit(); }} />
            {audit.failed ? <SurfaceStateCard size="line" kind="error" title={t('session.collaboration.pane.linkLoadFailed')}
                action={{ label: t('common.retry'), onPress: readAudit }} /> : null}
            {audit.rows?.length === 0 ? <SurfaceStateCard size="line" kind="empty" title={t('shareSheet.publicLink.auditEmpty')} /> : null}
            {audit.rows?.map(row => <Text key={row.id} testID={`${idPrefix}document-share-public-link-visit:${row.id}`} style={styles.visit}>
                {[new Date(row.accessedAt).toLocaleString(), row.ipAddress, row.userAgent].filter(Boolean).join(' · ')}
            </Text>)}
        </View> : null}
    </View>;
}
