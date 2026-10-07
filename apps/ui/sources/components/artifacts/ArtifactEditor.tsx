import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { ArtifactQuotaExceededError } from '@/sync/api/artifacts/apiArtifacts';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

import { artifactViewRoute } from './artifactBrowserModel';
import type { ArtifactQuota } from './artifactActionsClient';
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
    const [title, setTitle] = React.useState(artifact?.title ?? '');
    const [body, setBody] = React.useState(typeof artifact?.body === 'string' ? artifact.body : '');
    const [saving, setSaving] = React.useState(false);
    const [quota, setQuota] = React.useState<ArtifactQuota | null>(null);
    const changed = mode === 'new'
        ? title.trim().length > 0 || body.trim().length > 0
        : title !== (artifact?.title ?? '') || body !== (artifact?.body ?? '');

    const save = React.useCallback(async () => {
        if (saving || !changed) return;
        if (!title.trim() && !body.trim()) {
            await Modal.alert(t('common.error'), t('artifacts.emptyFieldsError'));
            return;
        }
        setSaving(true);
        setQuota(null);
        try {
            if (mode === 'new') {
                const artifactId = await sync.createArtifact(title.trim() || null, body.trim() || null);
                router.replace(artifactViewRoute(artifactId) as never);
            } else if (artifact) {
                await sync.updateArtifact(artifact.id, title.trim() || null, body.trim() || null);
                safeRouterBack({ router, fallbackHref: '/artifacts' });
            }
        } catch (error) {
            setSaving(false);
            if (error instanceof ArtifactQuotaExceededError) { setQuota(error.quota); return; }
            await Modal.alert(t('common.error'), mode === 'new' ? t('artifacts.createError') : t('artifacts.updateError'));
        }
    }, [artifact, body, changed, mode, router, saving, title]);

    const cancel = React.useCallback(async () => {
        if (changed && !(await Modal.confirm(t('artifacts.discardChanges'), t('artifacts.discardChangesDescription'), { destructive: true }))) return;
        safeRouterBack({ router, fallbackHref: '/artifacts' });
    }, [changed, router]);

    // A direct edit URL must not reinterpret a binary body as an empty Markdown document.
    if (mode === 'edit' && artifact?.body !== null && typeof artifact?.body === 'object') {
        return <ArtifactView artifactId={artifact.id} artifact={artifact} presentation="page" />;
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
