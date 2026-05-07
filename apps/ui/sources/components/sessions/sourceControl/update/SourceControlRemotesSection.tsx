import * as React from 'react';
import { View } from 'react-native';

import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import type { ScmRemoteInfo, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmRemoteAdd,
    sessionScmRemoteRemove,
    sessionScmRemoteSetUrl,
} from '@/sync/ops/sessions';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import {
    SourceControlUpdateButton,
    SourceControlUpdateInput,
    SourceControlUpdateSection,
    type SourceControlUpdateTheme,
} from './SourceControlUpdateControls';
import { SourceControlPublishRepositorySection } from './SourceControlPublishRepositorySection';

type EditingRemote =
    | { mode: 'add' }
    | { mode: 'edit'; remote: ScmRemoteInfo };

export function SourceControlRemotesSection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
    writeEnabled?: boolean;
}>) {
    const remotes = props.snapshot?.repo.remotes ?? [];
    const capabilities = props.snapshot?.capabilities;
    const canAdd = props.writeEnabled === true && capabilities?.writeRemoteAdd === true && !props.disabled;
    const canSetUrl = props.writeEnabled === true && capabilities?.writeRemoteSetUrl === true && !props.disabled;
    const canRemove = props.writeEnabled === true && capabilities?.writeRemoteRemove === true && !props.disabled;

    const [editing, setEditing] = React.useState<EditingRemote>({ mode: 'add' });
    const [name, setName] = React.useState('');
    const [fetchUrl, setFetchUrl] = React.useState('');
    const [pushUrl, setPushUrl] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const nameRef = React.useRef(name);
    const fetchUrlRef = React.useRef(fetchUrl);
    const pushUrlRef = React.useRef(pushUrl);

    const updateName = React.useCallback((value: string) => {
        nameRef.current = value;
        setName(value);
    }, []);

    const updateFetchUrl = React.useCallback((value: string) => {
        fetchUrlRef.current = value;
        setFetchUrl(value);
    }, []);

    const updatePushUrl = React.useCallback((value: string) => {
        pushUrlRef.current = value;
        setPushUrl(value);
    }, []);

    const beginAdd = React.useCallback(() => {
        setEditing({ mode: 'add' });
        updateName('');
        updateFetchUrl('');
        updatePushUrl('');
    }, [updateFetchUrl, updateName, updatePushUrl]);

    const beginEdit = React.useCallback((remote: ScmRemoteInfo) => {
        setEditing({ mode: 'edit', remote });
        updateName(remote.name);
        updateFetchUrl(remote.fetchUrl ?? '');
        updatePushUrl(remote.pushUrl ?? '');
    }, [updateFetchUrl, updateName, updatePushUrl]);

    const refresh = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [props.sessionId]);

    const showFailure = React.useCallback((fallback: string, response: { success: boolean; error?: string }) => {
        if (response.success) return;
        Modal.alert(t('common.error'), response.error || fallback);
    }, []);

    const save = React.useCallback(() => {
        void (async () => {
            const trimmedName = nameRef.current.trim();
            const trimmedFetchUrl = fetchUrlRef.current.trim();
            const trimmedPushUrl = pushUrlRef.current.trim();
            if (!trimmedName) {
                Modal.alert(t('common.error'), t('files.sourceControlOperations.update.remotes.errors.nameRequired'));
                return;
            }
            if (!trimmedFetchUrl) {
                Modal.alert(t('common.error'), t('files.sourceControlOperations.update.remotes.errors.fetchUrlRequired'));
                return;
            }

            setBusy(true);
            try {
                if (editing.mode === 'add') {
                    const response = await sessionScmRemoteAdd(props.sessionId, {
                        name: trimmedName,
                        fetchUrl: trimmedFetchUrl,
                        ...(trimmedPushUrl ? { pushUrl: trimmedPushUrl } : {}),
                    });
                    if (!response.success) {
                        showFailure(t('files.sourceControlOperations.update.remotes.errors.addFailed'), response);
                        return;
                    }
                    beginAdd();
                    await refresh();
                    return;
                }

                const response = await sessionScmRemoteSetUrl(props.sessionId, {
                    name: editing.remote.name,
                    fetchUrl: trimmedFetchUrl,
                    pushUrl: trimmedPushUrl || null,
                });
                if (!response.success) {
                    showFailure(t('files.sourceControlOperations.update.remotes.errors.saveFailed'), response);
                    return;
                }
                beginAdd();
                await refresh();
            } finally {
                setBusy(false);
            }
        })();
    }, [beginAdd, editing, props.sessionId, refresh, showFailure]);

    const removeRemote = React.useCallback((remote: ScmRemoteInfo) => {
        void (async () => {
            const confirmed = await Modal.confirm(
                t('files.sourceControlOperations.update.remotes.removeConfirmTitle'),
                t('files.sourceControlOperations.update.remotes.removeConfirmBody', { name: remote.name }),
                {
                    confirmText: t('files.sourceControlOperations.update.remotes.remove'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!confirmed) return;
            setBusy(true);
            try {
                const response = await sessionScmRemoteRemove(props.sessionId, { name: remote.name });
                if (!response.success) {
                    showFailure(t('files.sourceControlOperations.update.remotes.errors.removeFailed'), response);
                    return;
                }
                beginAdd();
                await refresh();
            } finally {
                setBusy(false);
            }
        })();
    }, [beginAdd, props.sessionId, refresh, showFailure]);

    const editorDisabled = busy || (editing.mode === 'add' ? !canAdd : !canSetUrl);

    return (
        <>
            <SourceControlPublishRepositorySection
                theme={props.theme}
                sessionId={props.sessionId}
                snapshot={props.snapshot}
                disabled={props.disabled}
                writeEnabled={props.writeEnabled}
            />
            <SourceControlUpdateSection
                theme={props.theme}
                title={t('files.sourceControlOperations.update.remotes.title')}
                testID="scm-update-remotes-section"
            >
                {remotes.length === 0 ? (
                    <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.sourceControlOperations.update.remotes.empty')}
                    </Text>
                ) : (
                    <View style={{ gap: 8 }}>
                        {remotes.map((remote) => (
                            <View
                                key={remote.name}
                                testID="scm-update-remote-row"
                                style={{
                                    borderWidth: 1,
                                    borderColor: props.theme.colors.divider,
                                    borderRadius: 8,
                                    padding: 10,
                                    gap: 8,
                                    backgroundColor: props.theme.colors.surfaceHigh,
                                }}
                            >
                                <View style={{ gap: 2 }}>
                                    <Text style={{ fontSize: 12, color: props.theme.colors.text, ...Typography.default('semiBold') }}>
                                        {remote.name}
                                    </Text>
                                    <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.mono() }} numberOfLines={1}>
                                        {remote.fetchUrl || t('files.sourceControlOperations.update.remotes.noFetchUrl')}
                                    </Text>
                                    {remote.pushUrl && remote.pushUrl !== remote.fetchUrl ? (
                                        <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.mono() }} numberOfLines={1}>
                                            {remote.pushUrl}
                                        </Text>
                                    ) : null}
                                </View>
                                <View style={{ flexDirection: 'row', gap: 8 }}>
                                    <SourceControlUpdateButton
                                        theme={props.theme}
                                        testID="scm-update-remote-edit"
                                        label={t('common.edit')}
                                        disabled={!canSetUrl || busy}
                                        onPress={() => beginEdit(remote)}
                                    />
                                    <SourceControlUpdateButton
                                        theme={props.theme}
                                        testID="scm-update-remote-remove"
                                        label={t('files.sourceControlOperations.update.remotes.remove')}
                                        kind="danger"
                                        disabled={!canRemove || busy}
                                        onPress={() => removeRemote(remote)}
                                    />
                                </View>
                            </View>
                        ))}
                    </View>
                )}

                <View style={{ gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={{ fontSize: 12, color: props.theme.colors.text, ...Typography.default('semiBold') }}>
                            {editing.mode === 'add'
                                ? t('files.sourceControlOperations.update.remotes.addTitle')
                                : t('files.sourceControlOperations.update.remotes.editTitle', { name: editing.remote.name })}
                        </Text>
                        <SourceControlUpdateButton
                            theme={props.theme}
                            testID="scm-update-add-remote"
                            label={t('files.sourceControlOperations.update.remotes.add')}
                            disabled={busy || editing.mode === 'add'}
                            onPress={beginAdd}
                        />
                    </View>
                    <SourceControlUpdateInput
                        theme={props.theme}
                        testID="scm-remote-editor-name"
                        accessibilityLabel={t('files.sourceControlOperations.update.remotes.nameLabel')}
                        placeholder={t('files.sourceControlOperations.update.remotes.namePlaceholder')}
                        value={name}
                        editable={editing.mode === 'add' && !editorDisabled}
                        onChangeText={updateName}
                    />
                    <SourceControlUpdateInput
                        theme={props.theme}
                        testID="scm-remote-editor-fetch-url"
                        accessibilityLabel={t('files.sourceControlOperations.update.remotes.fetchUrlLabel')}
                        placeholder={t('files.sourceControlOperations.update.remotes.fetchUrlPlaceholder')}
                        value={fetchUrl}
                        editable={!editorDisabled}
                        onChangeText={updateFetchUrl}
                    />
                    <SourceControlUpdateInput
                        theme={props.theme}
                        testID="scm-remote-editor-push-url"
                        accessibilityLabel={t('files.sourceControlOperations.update.remotes.pushUrlLabel')}
                        placeholder={t('files.sourceControlOperations.update.remotes.pushUrlPlaceholder')}
                        value={pushUrl}
                        editable={!editorDisabled}
                        onChangeText={updatePushUrl}
                    />
                    <SourceControlUpdateButton
                        theme={props.theme}
                        testID="scm-remote-editor-save"
                        label={editing.mode === 'add'
                            ? t('files.sourceControlOperations.update.remotes.add')
                            : t('common.save')}
                        kind="primary"
                        disabled={editorDisabled}
                        onPress={save}
                    />
                </View>
            </SourceControlUpdateSection>
        </>
    );
}
