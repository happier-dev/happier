import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const UPLOAD_LOCATION_OPTIONS: ReadonlyArray<{
    id: 'workspace' | 'os_temp';
    title: string;
    subtitle: string;
    iconName: IoniconName;
}> = [
    {
        id: 'workspace',
        title: 'Workspace directory (recommended)',
        subtitle: 'Uploads are written under a workspace-relative directory so the agent sandbox can read them reliably.',
        iconName: 'folder-outline',
    },
    {
        id: 'os_temp',
        title: 'OS temp directory',
        subtitle: 'Uploads are written to your OS temp directory. This can break in stricter sandboxes.',
        iconName: 'cloud-upload-outline',
    },
];

const VCS_IGNORE_OPTIONS: ReadonlyArray<{
    id: 'git_info_exclude' | 'gitignore' | 'none';
    title: string;
    subtitle: string;
    iconName: IoniconName;
}> = [
    {
        id: 'git_info_exclude',
        title: 'Ignore locally (.git/info/exclude) (recommended)',
        subtitle: 'Avoids accidental commits without modifying repository files.',
        iconName: 'shield-checkmark-outline',
    },
    {
        id: 'gitignore',
        title: 'Ignore via .gitignore',
        subtitle: 'Writes an entry to the workspace .gitignore file (may be committed).',
        iconName: 'git-branch-outline',
    },
    {
        id: 'none',
        title: 'Do not write ignore rules',
        subtitle: 'Uploads may be picked up by source control depending on your repo config.',
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
    const [uploadTtlMs, setUploadTtlMs] = useSettingMutable('attachmentsUploadsUploadTtlMs');
    const [chunkSizeBytes, setChunkSizeBytes] = useSettingMutable('attachmentsUploadsChunkSizeBytes');

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
                    title="Attachments"
                    footer="This feature is disabled by your server or build policy."
                >
                    <Item
                        title="File uploads"
                        subtitle="Disabled"
                        icon={<Ionicons name="attach-outline" size={29} color={theme.colors.warningCritical} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const renderIcon = (iconName: IoniconName) => (
        <Ionicons name={iconName} size={29} color={theme.colors.textSecondary} />
    );

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Upload location"
                footer="Workspace uploads are the most compatible option. OS temp uploads can be useful to avoid repository artifacts, but may not be readable in stricter sandboxes."
            >
                {UPLOAD_LOCATION_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveUploadLocation === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setUploadLocation(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title="Workspace directory" footer="Only used when upload location is set to Workspace directory.">
                <Item
                    title="Uploads directory"
                    subtitle={effectiveWorkspaceRelativeDir}
                    icon={renderIcon('folder-outline')}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            'Uploads directory',
                            'Enter a workspace-relative directory (no absolute paths, no ..).',
                            { placeholder: effectiveWorkspaceRelativeDir },
                        );
                        if (raw === null) return;
                        const normalized = normalizeWorkspaceRelativeDir(raw);
                        if (!normalized) {
                            Modal.alert('Invalid directory', 'Use a relative path like `.happier/uploads`.');
                            return;
                        }
                        setWorkspaceRelativeDir(normalized);
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title="Source control ignore"
                footer="Local-only ignores avoid accidental commits. If you choose .gitignore, this may modify a tracked file."
            >
                {VCS_IGNORE_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveIgnoreStrategy === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setVcsIgnoreStrategy(option.id)}
                        showChevron={false}
                    />
                ))}
                <Item
                    title="Write ignore rules"
                    subtitle={vcsIgnoreWritesEnabled === false ? 'Disabled' : 'Enabled'}
                    icon={renderIcon('create-outline')}
                    showChevron={false}
                    onPress={() => setVcsIgnoreWritesEnabled(!(vcsIgnoreWritesEnabled === false))}
                />
            </ItemGroup>

            <ItemGroup title="Limits" footer="These limits are enforced by the local CLI upload handler (best-effort).">
                <Item
                    title="Max attachment size (bytes)"
                    subtitle={typeof maxFileBytes === 'number' ? String(maxFileBytes) : 'Default'}
                    icon={renderIcon('resize-outline')}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            'Max attachment size (bytes)',
                            'Example: 26214400 for 25MB.',
                            { placeholder: typeof maxFileBytes === 'number' ? String(maxFileBytes) : '26214400' },
                        );
                        if (raw === null) return;
                        const parsed = parsePositiveInt(raw, { min: 1024, max: 1024 * 1024 * 1024 });
                        if (parsed == null) {
                            Modal.alert('Invalid value', 'Enter a number between 1024 and 1073741824.');
                            return;
                        }
                        setMaxFileBytes(parsed);
                    }}
                />
                <Item
                    title="Upload TTL (ms)"
                    subtitle={typeof uploadTtlMs === 'number' ? String(uploadTtlMs) : 'Default'}
                    icon={renderIcon('timer-outline')}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            'Upload TTL (ms)',
                            'How long an upload can stay idle before it expires.',
                            { placeholder: typeof uploadTtlMs === 'number' ? String(uploadTtlMs) : String(5 * 60 * 1000) },
                        );
                        if (raw === null) return;
                        const parsed = parsePositiveInt(raw, { min: 5000, max: 60 * 60 * 1000 });
                        if (parsed == null) {
                            Modal.alert('Invalid value', 'Enter a number between 5000 and 3600000.');
                            return;
                        }
                        setUploadTtlMs(parsed);
                    }}
                />
                <Item
                    title="Preferred chunk size (bytes)"
                    subtitle={typeof chunkSizeBytes === 'number' ? String(chunkSizeBytes) : 'Default'}
                    icon={renderIcon('albums-outline')}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            'Preferred chunk size (bytes)',
                            'The CLI may clamp this to safe bounds.',
                            { placeholder: typeof chunkSizeBytes === 'number' ? String(chunkSizeBytes) : String(256 * 1024) },
                        );
                        if (raw === null) return;
                        const parsed = parsePositiveInt(raw, { min: 4096, max: 1024 * 1024 });
                        if (parsed == null) {
                            Modal.alert('Invalid value', 'Enter a number between 4096 and 1048576.');
                            return;
                        }
                        setChunkSizeBytes(parsed);
                    }}
                />
            </ItemGroup>
        </ItemList>
    );
});
