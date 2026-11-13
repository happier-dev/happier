import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { AvatarStylePreviewIcon } from '@/components/settings/appearance/AvatarStylePreviewIcon';
import { AVATAR_STYLE_OPTIONS, isAvatarStyleId } from '@/components/ui/avatar/avatarStyleOptions';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import { t } from '@/text';

type LineagePresetKind = 'parent' | 'child';
type LineageAppearancePresets = Readonly<Record<string, unknown> & {
    parent?: Readonly<Record<string, unknown> & { density?: 'detailed' | 'cozy' | 'narrow'; avatarStyle?: AvatarStyleId }>;
    child?: Readonly<Record<string, unknown> & { density?: 'detailed' | 'cozy' | 'narrow'; avatarStyle?: AvatarStyleId }>;
}>;

function updateLineageAppearancePreset(
    source: LineageAppearancePresets,
    kind: LineagePresetKind,
    field: 'density' | 'avatarStyle',
    value: string | null,
): LineageAppearancePresets {
    const preset: Record<string, unknown> = { ...(source[kind] ?? {}) };
    if (value === null) delete preset[field];
    else preset[field] = value;
    const next: Record<string, unknown> & { parent?: Record<string, unknown>; child?: Record<string, unknown> } = { ...source };
    if (Object.keys(preset).length > 0) next[kind] = preset;
    else delete next[kind];
    return next;
}

export const LineageAppearancePresetsEditor = React.memo(function LineageAppearancePresetsEditor() {
    const { theme } = useUnistyles();
    const enabled = useFeatureEnabled('sessions.lineageAppearancePresets');
    const [value, setValue] = useSettingMutable('sessionLineageAppearancePresetsV1');
    const [openMenu, setOpenMenu] = React.useState<string | null>(null);
    const popoverBoundaryRef = React.useRef<unknown>(null);
    const presets = (value && typeof value === 'object' ? value : {}) as LineageAppearancePresets;

    const densityItems = React.useMemo(() => [
        { id: 'inherit', title: t('settingsSession.lineageAppearance.inherit') },
        { id: 'detailed', title: t('settingsAppearance.sessionListDensity.detailed'), subtitle: t('settingsAppearance.sessionListDensity.detailedDescription') },
        { id: 'cozy', title: t('settingsAppearance.sessionListDensity.cozy'), subtitle: t('settingsAppearance.sessionListDensity.cozyDescription') },
        { id: 'narrow', title: t('settingsAppearance.sessionListDensity.narrow'), subtitle: t('settingsAppearance.sessionListDensity.narrowDescription') },
    ], []);
    const avatarItems = React.useMemo(() => [
        { id: 'inherit', title: t('settingsSession.lineageAppearance.inherit') },
        ...AVATAR_STYLE_OPTIONS.map((option) => ({
            id: option.id,
            title: t(option.labelKey),
            icon: <AvatarStylePreviewIcon styleId={option.id} />,
        })),
    ], []);
    const select = React.useCallback((kind: LineagePresetKind, field: 'density' | 'avatarStyle', itemId: string) => {
        if (itemId !== 'inherit') {
            if (field === 'density' && itemId !== 'detailed' && itemId !== 'cozy' && itemId !== 'narrow') return;
            if (field === 'avatarStyle' && !isAvatarStyleId(itemId)) return;
        }
        setValue(updateLineageAppearancePreset(presets, kind, field, itemId === 'inherit' ? null : itemId));
    }, [presets, setValue]);

    if (!enabled) return null;
    const rows = [
        { key: 'parent-density', kind: 'parent' as const, field: 'density' as const, selectedId: presets.parent?.density ?? 'inherit', title: t('settingsSession.lineageAppearance.parentDensityTitle'), subtitle: t('settingsSession.lineageAppearance.parentDensitySubtitle'), icon: <Icon name="stack" size={29} color={theme.colors.accent.indigo} />, items: densityItems },
        { key: 'parent-avatar', kind: 'parent' as const, field: 'avatarStyle' as const, selectedId: presets.parent?.avatarStyle ?? 'inherit', title: t('settingsSession.lineageAppearance.parentAvatarTitle'), subtitle: t('settingsSession.lineageAppearance.parentAvatarSubtitle'), icon: presets.parent?.avatarStyle ? <AvatarStylePreviewIcon styleId={presets.parent.avatarStyle} /> : <Icon name="users" size={29} color={theme.colors.accent.indigo} />, items: avatarItems },
        { key: 'child-density', kind: 'child' as const, field: 'density' as const, selectedId: presets.child?.density ?? 'inherit', title: t('settingsSession.lineageAppearance.childDensityTitle'), subtitle: t('settingsSession.lineageAppearance.childDensitySubtitle'), icon: <Icon name="git-branch" size={29} color={theme.colors.accent.indigo} />, items: densityItems },
        { key: 'child-avatar', kind: 'child' as const, field: 'avatarStyle' as const, selectedId: presets.child?.avatarStyle ?? 'inherit', title: t('settingsSession.lineageAppearance.childAvatarTitle'), subtitle: t('settingsSession.lineageAppearance.childAvatarSubtitle'), icon: presets.child?.avatarStyle ? <AvatarStylePreviewIcon styleId={presets.child.avatarStyle} /> : <Icon name="users" size={29} color={theme.colors.accent.indigo} />, items: avatarItems },
    ];
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.lineageAppearance.title')}>
                {rows.map((row) => (
                    <DropdownMenu
                        key={row.key}
                        open={openMenu === row.key}
                        onOpenChange={(next) => setOpenMenu(next ? row.key : null)}
                        variant="selectable"
                        search={false}
                        selectedId={row.selectedId}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: row.title,
                            subtitle: row.subtitle,
                            icon: row.icon,
                            showSelectedSubtitle: false,
                            itemProps: { testID: `settings-session-lineage-${row.key}-trigger` },
                        }}
                        items={row.items}
                        onSelect={(itemId) => select(row.kind, row.field, itemId)}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
});
