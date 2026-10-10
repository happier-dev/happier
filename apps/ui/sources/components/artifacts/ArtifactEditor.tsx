import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Modal } from '@/modal';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

import { artifactViewRoute } from './artifactBrowserModel';
import { useArtifactActionsClient, type ArtifactQuota } from './artifactActionsClient';
import { ArtifactView } from './ArtifactView';

/**
 * Writing a document: its title edited in the page header, its Markdown below, one Save. A save the
 * server refuses for a budget keeps every edit and names the size and the cap (lab A8p).
 */
export function ArtifactEditor(props: Readonly<{ artifact: DecryptedArtifact | null; mode: 'new' | 'edit' }>): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const { artifact, mode } = props;
    const client = useArtifactActionsClient();
    const scope = useActiveServerAccountScope();
    // Draft fields, metadata and CAS belong to the same opening read, never a later socket head.
    const [opening] = React.useState(artifact);
    const [title, setTitle] = React.useState(artifact?.title ?? '');
    const [body, setBody] = React.useState(typeof artifact?.body === 'string' ? artifact.body : '');
    const [saving, setSaving] = React.useState(false);
    const [quota, setQuota] = React.useState<ArtifactQuota | null>(null);
    const [conflict, setConflict] = React.useState(false);
    const changed = mode === 'new'
        ? title.trim().length > 0 || body.trim().length > 0
        : title !== (opening?.title ?? '') || body !== (opening?.body ?? '');

    const save = React.useCallback(async () => {
        if (saving || !changed) return;
        if (!title.trim() && !body.trim()) {
            await Modal.alert(t('common.error'), t('artifacts.emptyFieldsError'));
            return;
        }
        setSaving(true);
        setQuota(null);
        try {
            if (!client || (mode === 'edit' && (!opening?.isDecrypted || !opening.rawHeader || opening.bodyVersion === undefined))) {
                throw new Error('artifact_content_unavailable');
            }
            const header = ArtifactHeaderMetadataV1Schema.parse({ ...(mode === 'edit' ? opening?.rawHeader : {}), title: title.trim() || null });
            const outcome = mode === 'new'
                ? await client.createArtifact({ header, body: body.trim() })
                : await client.updateArtifact({ artifactId: opening!.id, header, body: body.trim(),
                    expectedRevision: { headerVersion: opening!.headerVersion, bodyVersion: opening!.bodyVersion! } });
            if ('approvalId' in outcome) {
                if (scope) router.push(`/inbox/approvals/${encodeURIComponent(outcome.approvalId)}?serverId=${encodeURIComponent(scope.serverId)}` as never);
                return;
            }
            if (!outcome.ok) {
                if (outcome.failure.quota) { setQuota(outcome.failure.quota); return; }
                if (outcome.failure.code === 'version_mismatch') { setConflict(true); return; }
                throw new Error(outcome.failure.code);
            }
            if (mode === 'new') router.replace(artifactViewRoute(outcome.value.artifactId) as never);
            else safeRouterBack({ router, fallbackHref: '/artifacts' });
        } catch {
            await Modal.alert(t('common.error'), mode === 'new' ? t('artifacts.createError') : t('artifacts.updateError'));
        } finally {
            setSaving(false);
        }
    }, [opening, body, changed, client, mode, router, saving, scope, title]);

    const cancel = React.useCallback(async () => {
        if (changed && !(await Modal.confirm(t('artifacts.discardChanges'), t('artifacts.discardChangesDescription'), { destructive: true }))) return;
        safeRouterBack({ router, fallbackHref: '/artifacts' });
    }, [changed, router]);

    // A direct edit URL must not reinterpret a binary body as an empty Markdown document.
    if (mode === 'edit' && opening?.body !== null && typeof opening?.body === 'object') {
        return <ArtifactView artifactId={opening.id} artifact={opening} presentation="page" />;
    }

    return (
        <ItemList testID={`artifact-editor:${mode}`}>
            <PageHeader
                testID="artifact-editor:header"
                title={title || t('artifacts.untitled')}
                alwaysShowTitle
                titleEditor={{
                    value: title,
                    placeholder: t('artifacts.untitled'),
                    accessibilityLabel: t('artifacts.titlePlaceholder'),
                    onChangeText: setTitle,
                    testID: 'artifact-editor:title',
                }}
                primaryAction={{ title: t('artifacts.save'), onPress: save, disabled: !changed, loading: saving, testID: 'artifact-editor:save' }}
                cancelAction={{ title: t('common.cancel'), onPress: cancel, testID: 'artifact-editor:cancel' }}
            />
            {conflict ? <SurfaceFreshnessLine testID="artifact-editor:conflict" tone="warning" reason={t('sessionInstructions.saveConflict')} /> : null}
            {quota ? (
                <View style={styles.refusal} testID="artifact-editor:quota" accessibilityRole="alert">
                    <Icon name="warning" size={17} color={theme.colors.state.warning.foreground} />
                    <View style={styles.refusalText}>
                        <Text style={styles.refusalTitle}>
                            {quota.budget === 'document' ? t('artifacts.browser.quota.documentTitle') : t('artifacts.browser.quota.accountTitle')}
                        </Text>
                        <Text style={styles.refusalBody}>
                            {quota.budget === 'document'
                                ? t('artifacts.browser.quota.documentBody', { size: formatByteSize(quota.usedBytes), limit: formatByteSize(quota.limitBytes) })
                                : t('artifacts.browser.quota.accountBody', { used: formatByteSize(quota.usedBytes), limit: formatByteSize(quota.limitBytes) })}
                        </Text>
                    </View>
                </View>
            ) : null}
            <ItemGroup title={t('artifacts.bodyLabel')} surface="none">
                <FieldTextInput
                    testID="artifact-editor:body"
                    value={body}
                    onChangeText={setBody}
                    accessibilityLabel={t('artifacts.bodyLabel')}
                    placeholder={t('artifacts.bodyPlaceholder')}
                    multiline
                    minLines={16}
                    monospace
                    autoFocus={mode === 'new'}
                />
            </ItemGroup>
        </ItemList>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    refusal: {
        flexDirection: 'row',
        gap: 10,
        padding: 14,
        borderRadius: 12,
        marginTop: 8,
        backgroundColor: theme.colors.state.warning.background,
    },
    refusalText: {
        flex: 1,
        gap: 2,
    },
    refusalTitle: {
        fontSize: 14,
        lineHeight: 19,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    refusalBody: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));
