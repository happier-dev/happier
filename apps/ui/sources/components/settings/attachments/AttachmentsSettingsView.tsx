import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { t, type TranslationKey } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const UPLOAD_LOCATION_OPTIONS: ReadonlyArray<{
    id: 'workspace' | 'os_temp';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'workspace',
        titleKey: 'settingsAttachments.uploadLocation.options.workspace.title',
        subtitleKey: 'settingsAttachments.uploadLocation.options.workspace.subtitle',
        iconName: 'folder-outline',
    },
    {
        id: 'os_temp',
        titleKey: 'settingsAttachments.uploadLocation.options.osTemp.title',
        subtitleKey: 'settingsAttachments.uploadLocation.options.osTemp.subtitle',
        iconName: 'cloud-upload-outline',
    },
];

const VCS_IGNORE_OPTIONS: ReadonlyArray<{
    id: 'git_info_exclude' | 'gitignore' | 'none';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'git_info_exclude',
        titleKey: 'settingsAttachments.sourceControlIgnore.options.gitInfoExclude.title',
        subtitleKey: 'settingsAttachments.sourceControlIgnore.options.gitInfoExclude.subtitle',
        iconName: 'shield-checkmark-outline',
    },
    {
        id: 'gitignore',
        titleKey: 'settingsAttachments.sourceControlIgnore.options.gitignore.title',
        subtitleKey: 'settingsAttachments.sourceControlIgnore.options.gitignore.subtitle',
        iconName: 'git-branch-outline',
    },
    {
        id: 'none',
        titleKey: 'settingsAttachments.sourceControlIgnore.options.none.title',
        subtitleKey: 'settingsAttachments.sourceControlIgnore.options.none.subtitle',
        iconName: 'alert-circle-outline',
    },
];

function normalizeWorkspaceRelativeDir(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
    const parts = trimmed.split(/[\\/]+/g).filter(Boolean);
    if (parts.some((p) => p === '.' || p === '..')) return null;
    return parts.join('/');
}

function parsePositiveInt(input: string, opts: Readonly<{ min: number; max: number }>): number | null {
    const raw = Number(input);
    if (!Number.isFinite(raw)) return null;
    const rounded = Math.floor(raw);
    if (rounded < opts.min || rounded > opts.max) return null;
    return rounded;
}

export const AttachmentsSettingsView = React.memo(function AttachmentsSettingsView() {
    const { theme } = useUnistyles();
    const attachmentsEnabled = useFeatureEnabled('attachments.uploads');

    const [uploadLocation, setUploadLocation] = useSettingMutable('attachmentsUploadsUploadLocation');
    const [workspaceRelativeDir, setWorkspaceRelativeDir] = useSettingMutable('attachmentsUploadsWorkspaceRelativeDir');
    const [vcsIgnoreStrategy, setVcsIgnoreStrategy] = useSettingMutable('attachmentsUploadsVcsIgnoreStrategy');
    const [vcsIgnoreWritesEnabled, setVcsIgnoreWritesEnabled] = useSettingMutable('attachmentsUploadsVcsIgnoreWritesEnabled');
    const [maxFileBytes, setMaxFileBytes] = useSettingMutable('attachmentsUploadsMaxFileBytes');

    const effectiveUploadLocation = uploadLocation === 'os_temp' ? 'os_temp' : 'workspace';
    const effectiveIgnoreStrategy =
        vcsIgnoreStrategy === 'gitignore' || vcsIgnoreStrategy === 'none' ? vcsIgnoreStrategy : 'git_info_exclude';
    const effectiveWorkspaceRelativeDir = typeof workspaceRelativeDir === 'string' && workspaceRelativeDir.trim().length > 0
        ? workspaceRelativeDir.trim()
        : '.happier/uploads';

    if (!attachmentsEnabled) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup
                    title={t('settingsAttachments.disabled.title')}
                    footer={t('settingsAttachments.disabled.footer')}
                >
                    <Item
                        title={t('settingsAttachments.fileUploads.title')}
                        subtitle={t('common.disabled')}
                        icon={<Ionicons name="attach-outline" size={29} color={theme.colors.state.danger.foreground} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const renderIcon = (iconName: IoniconName) => (
        <Ionicons name={iconName} size={29} color={theme.colors.text.secondary} />
    );

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsAttachments.uploadLocation.title')}
                footer={t('settingsAttachments.uploadLocation.footer')}
            >
                {UPLOAD_LOCATION_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveUploadLocation === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setUploadLocation(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title={t('settingsAttachments.workspaceDirectory.title')} footer={t('settingsAttachments.workspaceDirectory.footer')}>
                <Item
                    title={t('settingsAttachments.workspaceDirectory.uploadsDirectory.title')}
                    subtitle={effectiveWorkspaceRelativeDir}
                    icon={renderIcon('folder-outline')}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('settingsAttachments.workspaceDirectory.uploadsDirectory.promptTitle'),
                            t('settingsAttachments.workspaceDirectory.uploadsDirectory.promptMessage'),
                            { placeholder: effectiveWorkspaceRelativeDir },
                        );
                        if (raw === null) return;
                        const normalized = normalizeWorkspaceRelativeDir(raw);
                        if (!normalized) {
                            Modal.alert(t('settingsAttachments.workspaceDirectory.uploadsDirectory.invalidDirectoryTitle'), t('settingsAttachments.workspaceDirectory.uploadsDirectory.invalidDirectoryMessage'));
                            return;
                        }
                        setWorkspaceRelativeDir(normalized);
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsAttachments.sourceControlIgnore.title')}
                footer={t('settingsAttachments.sourceControlIgnore.footer')}
            >
                {VCS_IGNORE_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveIgnoreStrategy === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setVcsIgnoreStrategy(option.id)}
                        showChevron={false}
                    />
                ))}
                <Item
                    title={t('settingsAttachments.sourceControlIgnore.writeIgnoreRules.title')}
                    subtitle={vcsIgnoreWritesEnabled === false ? t('common.disabled') : t('common.enabled')}
                    icon={renderIcon('create-outline')}
                    showChevron={false}
                    onPress={() => setVcsIgnoreWritesEnabled(!(vcsIgnoreWritesEnabled === false))}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsAttachments.limits.title')} footer={t('settingsAttachments.limits.footer')}>
                <Item
                    title={t('settingsAttachments.limits.maxAttachmentSize.title')}
                    subtitle={typeof maxFileBytes === 'number' ? String(maxFileBytes) : t('common.default')}
                    icon={renderIcon('resize-outline')}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('settingsAttachments.limits.maxAttachmentSize.promptTitle'),
                            t('settingsAttachments.limits.maxAttachmentSize.promptMessage'),
                            { placeholder: typeof maxFileBytes === 'number' ? String(maxFileBytes) : '26214400' },
                        );
                        if (raw === null) return;
                        const parsed = parsePositiveInt(raw, { min: 1024, max: 1024 * 1024 * 1024 });
                        if (parsed == null) {
                            Modal.alert(t('settingsAttachments.limits.invalidValueTitle'), t('settingsAttachments.limits.maxAttachmentSize.invalidValueMessage'));
                            return;
                        }
                        setMaxFileBytes(parsed);
                    }}
                />
            </ItemGroup>
        </ItemList>
    );
});
