import * as React from 'react';
import { useRouter } from 'expo-router';

import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkillMark } from '@/components/settings/skills/SkillKindGlyph';
import { SKILLS_COLLECTION_ROUTE } from '@/components/settings/skills/skillsCollectionModel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { t } from '@/text';

export type ProfileSkillSeedsLibrary = Pick<SkillsLibrary, 'status' | 'items' | 'unavailableItems' | 'retry'>;

/**
 * "Skills this Profile adds": the library skills added to every session started with this Profile (D21),
 * kept in the draft's `skillSeeds` and saved with the Profile. Rows are the shared capability rows; a
 * seed that has left the library stays visible so it can be removed.
 */
export function ProfileSkillSeedsSection(props: Readonly<{
    seeds: readonly string[];
    library: ProfileSkillSeedsLibrary;
    onChange: (next: readonly string[]) => void;
}>) {
    const router = useRouter();
    const { seeds, library, onChange } = props;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const byId = React.useMemo(() => new Map(library.items.map(item => [item.skillId, item])), [library.items]);
    // The library knows these skills but cannot open them: they are in it, so never "Not in your library".
    const unreadableById = React.useMemo(
        () => new Map((library.unavailableItems ?? []).filter(item => item.reason !== 'not_found').map(item => [item.skillId, item])),
        [library.unavailableItems],
    );
    const candidates = React.useMemo(
        () => library.items.filter(item => !seeds.includes(item.skillId)),
        [library.items, seeds],
    );
    const ready = library.status === 'ready';
    const remove = React.useCallback(
        (skillId: string) => onChange(seeds.filter(id => id !== skillId)),
        [onChange, seeds],
    );
    const add = React.useCallback((skillId: string) => {
        setMenuOpen(false);
        if (!seeds.includes(skillId)) onChange([...seeds, skillId]);
    }, [onChange, seeds]);

    const action = ready && library.items.length > 0 ? (
        <DropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            variant="selectable"
            rowKind="item"
            search
            searchPlaceholder={t('capabilities.profileSeeds.searchPlaceholder')}
            emptyLabel={t('capabilities.profileSeeds.nothingToAdd')}
            showCategoryTitles={false}
            matchTriggerWidth={false}
            placement="bottom"
            popoverAnchorAlign="end"
            popoverPhonePresentation="sheet"
            popoverAccessibilityLabel={t('capabilities.profileSeeds.addTitle')}
            trigger={({ open, toggle }) => (
                <SectionActionButton
                    testID="profile-skill-seeds:add"
                    title={t('capabilities.profileSeeds.add')}
                    icon="plus"
                    expanded={open}
                    onPress={toggle}
                />
            )}
            items={candidates.map(item => ({
                id: item.skillId,
                testID: `profile-skill-seeds:pick:${item.skillId}`,
                title: item.name,
                ...(item.description ? { subtitle: item.description } : {}),
            }))}
            onSelect={add}
        />
    ) : undefined;

    return (
        <ItemGroup
            title={t('capabilities.profileSeeds.title')}
            description={t('capabilities.profileSeeds.description')}
            {...(action ? { action } : {})}
        >
            {seeds.map(skillId => {
                const item = byId.get(skillId);
                const unreadable = item === undefined ? unreadableById.get(skillId) : undefined;
                // A failed or pending read says nothing about membership: only a ready library can say "not in it".
                const gone = item === undefined && unreadable === undefined && ready;
                // A skill we cannot name keeps a neutral name, never a raw id; its state reads beneath it.
                const title = item?.name ?? unreadable?.title ?? t('capabilities.profileSeeds.pending');
                const rowName = title;
                const description = item?.description
                    ?? (unreadable ? t('capabilities.profileSeeds.unreadableItem') : gone ? t('capabilities.profileSeeds.missing') : null);
                return (
                    <CapabilityRow
                        key={skillId}
                        testID={`profile-skill-seeds:row:${skillId}`}
                        title={title}
                        description={description}
                        mark={<SkillMark firstParty={item?.provenance.kind === 'first_party'} />}
                        action={(
                            <IconButton
                                testID={`profile-skill-seeds:row:${skillId}:remove`}
                                iconName="x"
                                size={24}
                                variant="plain"
                                accessibilityLabel={t('capabilities.profileSeeds.remove', { skill: rowName })}
                                tooltip={t('capabilities.profileSeeds.remove', { skill: rowName })}
                                onPress={() => remove(skillId)}
                            />
                        )}
                        density="page"
                    />
                );
            })}
            {library.status === 'loading' && seeds.length === 0 ? (
                <SurfaceStateCard
                    testID="profile-skill-seeds:reading"
                    size="line"
                    kind="loading"
                    title={t('capabilities.profileSeeds.reading')}
                />
            ) : null}
            {library.status === 'unavailable' ? (
                <SurfaceStateCard
                    testID="profile-skill-seeds:unreadable"
                    size="line"
                    kind="error"
                    title={t('capabilities.profileSeeds.unreadable')}
                    action={{ label: t('capabilities.profileSeeds.tryAgain'), onPress: library.retry }}
                />
            ) : null}
            {ready && library.items.length === 0 ? (
                <SurfaceStateCard
                    testID="profile-skill-seeds:empty-library"
                    size="line"
                    kind="empty"
                    title={t('capabilities.profileSeeds.emptyLibrary')}
                    action={{ label: t('capabilities.profileSeeds.openSkills'), onPress: () => router.push(SKILLS_COLLECTION_ROUTE) }}
                />
            ) : null}
            {ready && library.items.length > 0 && seeds.length === 0 ? (
                <SurfaceStateCard
                    testID="profile-skill-seeds:empty"
                    size="line"
                    kind="empty"
                    title={t('capabilities.profileSeeds.empty')}
                />
            ) : null}
        </ItemGroup>
    );
}
