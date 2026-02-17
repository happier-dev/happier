import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';

type ToolViewDetailLevel = 'title' | 'summary' | 'full';
type ToolDetailLevelTranslationKey =
    | 'settingsSession.toolDetailLevel.defaultTitle'
    | 'settingsSession.toolDetailLevel.defaultSubtitle'
    | 'settingsSession.toolDetailLevel.titleOnlyTitle'
    | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
    | 'settingsSession.toolDetailLevel.summaryTitle'
    | 'settingsSession.toolDetailLevel.summarySubtitle'
    | 'settingsSession.toolDetailLevel.fullTitle'
    | 'settingsSession.toolDetailLevel.fullSubtitle';

const TOOL_DETAIL_LEVEL_OPTIONS = [
    {
        key: 'title',
        titleKey: 'settingsSession.toolDetailLevel.titleOnlyTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.titleOnlySubtitle',
    },
    {
        key: 'summary',
        titleKey: 'settingsSession.toolDetailLevel.summaryTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.summarySubtitle',
    },
    {
        key: 'full',
        titleKey: 'settingsSession.toolDetailLevel.fullTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.fullSubtitle',
    },
] as const satisfies ReadonlyArray<{
    key: ToolViewDetailLevel;
    titleKey:
        | 'settingsSession.toolDetailLevel.titleOnlyTitle'
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;

const TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS = [
    {
        key: 'default',
        titleKey: 'settingsSession.toolDetailLevel.defaultTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.defaultSubtitle',
    },
    ...TOOL_DETAIL_LEVEL_OPTIONS,
] as const satisfies ReadonlyArray<{
    key: ToolViewDetailLevel | 'default';
    titleKey:
        | 'settingsSession.toolDetailLevel.defaultTitle'
        | 'settingsSession.toolDetailLevel.titleOnlyTitle'
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.defaultSubtitle'
        | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;

const TOOL_OVERRIDE_KEYS: Array<{ toolName: string; title: string }> = [
    { toolName: 'Bash', title: 'Bash' },
    { toolName: 'Read', title: 'Read' },
    { toolName: 'Write', title: 'Write' },
    { toolName: 'Edit', title: 'Edit' },
    { toolName: 'MultiEdit', title: 'MultiEdit' },
    { toolName: 'Glob', title: 'Glob' },
    { toolName: 'Grep', title: 'Grep' },
    { toolName: 'LS', title: 'LS' },
    { toolName: 'CodeSearch', title: 'CodeSearch' },
    { toolName: 'TodoWrite', title: 'TodoWrite' },
    { toolName: 'TodoRead', title: 'TodoRead' },
    { toolName: 'WebFetch', title: 'WebFetch' },
    { toolName: 'WebSearch', title: 'WebSearch' },
    { toolName: 'Task', title: 'Task' },
    { toolName: 'Patch', title: 'Patch' },
    { toolName: 'Diff', title: 'Diff' },
    { toolName: 'Reasoning', title: 'Reasoning' },
    { toolName: 'ExitPlanMode', title: 'ExitPlanMode' },
    { toolName: 'AskUserQuestion', title: 'AskUserQuestion' },
    { toolName: 'change_title', title: 'change_title' },
];

export const ToolRenderingSettingsView = React.memo(function ToolRenderingSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);

    const [toolViewDetailLevelDefault, setToolViewDetailLevelDefault] = useSettingMutable('toolViewDetailLevelDefault');
    const [toolViewDetailLevelDefaultLocalControl, setToolViewDetailLevelDefaultLocalControl] = useSettingMutable('toolViewDetailLevelDefaultLocalControl');
    const [toolViewDetailLevelByToolName, setToolViewDetailLevelByToolName] = useSettingMutable('toolViewDetailLevelByToolName');
    const [toolViewShowDebugByDefault, setToolViewShowDebugByDefault] = useSettingMutable('toolViewShowDebugByDefault');

    const [openToolDetailMenu, setOpenToolDetailMenu] = React.useState<null | string>(null);
    const tToolDetail = t as (key: ToolDetailLevelTranslationKey) => string;

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.toolRendering.title')}
                footer={t('settingsSession.toolRendering.footer')}
            >
                <DropdownMenu
                    open={openToolDetailMenu === 'toolViewDetailLevelDefault'}
                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'toolViewDetailLevelDefault' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={toolViewDetailLevelDefault as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    trigger={({ open, toggle }) => (
                        <Item
                            title={t('settingsSession.toolRendering.defaultToolDetailLevelTitle')}
                            subtitle={
                                (() => {
                                    const key = TOOL_DETAIL_LEVEL_OPTIONS.find((opt) => opt.key === toolViewDetailLevelDefault)?.titleKey;
                                    return key ? tToolDetail(key) : String(toolViewDetailLevelDefault);
                                })()
                            }
                            icon={<Ionicons name="construct-outline" size={29} color="#007AFF" />}
                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                            onPress={toggle}
                            showChevron={false}
                            selected={false}
                        />
                    )}
                    items={TOOL_DETAIL_LEVEL_OPTIONS.map((opt) => ({
                        id: opt.key,
                        title: tToolDetail(opt.titleKey),
                        subtitle: tToolDetail(opt.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="list-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setToolViewDetailLevelDefault(id as any);
                        setOpenToolDetailMenu(null);
                    }}
                />

                <DropdownMenu
                    open={openToolDetailMenu === 'toolViewDetailLevelDefaultLocalControl'}
                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'toolViewDetailLevelDefaultLocalControl' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={toolViewDetailLevelDefaultLocalControl as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    trigger={({ open, toggle }) => (
                        <Item
                            title={t('settingsSession.toolRendering.localControlDefaultTitle')}
                            subtitle={
                                (() => {
                                    const key = TOOL_DETAIL_LEVEL_OPTIONS.find((opt) => opt.key === toolViewDetailLevelDefaultLocalControl)?.titleKey;
                                    return key ? tToolDetail(key) : String(toolViewDetailLevelDefaultLocalControl);
                                })()
                            }
                            icon={<Ionicons name="shield-outline" size={29} color="#FF9500" />}
                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                            onPress={toggle}
                            showChevron={false}
                            selected={false}
                        />
                    )}
                    items={TOOL_DETAIL_LEVEL_OPTIONS.map((opt) => ({
                        id: opt.key,
                        title: tToolDetail(opt.titleKey),
                        subtitle: tToolDetail(opt.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="list-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setToolViewDetailLevelDefaultLocalControl(id as any);
                        setOpenToolDetailMenu(null);
                    }}
                />

                <Item
                    title={t('settingsSession.toolRendering.showDebugByDefaultTitle')}
                    subtitle={t('settingsSession.toolRendering.showDebugByDefaultSubtitle')}
                    icon={<Ionicons name="code-slash-outline" size={29} color="#5856D6" />}
                    rightElement={<Switch value={toolViewShowDebugByDefault} onValueChange={setToolViewShowDebugByDefault} />}
                    showChevron={false}
                    onPress={() => setToolViewShowDebugByDefault(!toolViewShowDebugByDefault)}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.toolDetailOverrides.title')}
                footer={t('settingsSession.toolDetailOverrides.footer')}
            >
                {TOOL_OVERRIDE_KEYS.map((toolKey, index) => {
                    const override = (toolViewDetailLevelByToolName as any)?.[toolKey.toolName] as ToolViewDetailLevel | undefined;
                    const selected = override ?? 'default';
                    const showDivider = index < TOOL_OVERRIDE_KEYS.length - 1;

                    return (
                        <DropdownMenu
                            key={toolKey.toolName}
                            open={openToolDetailMenu === `toolOverride:${toolKey.toolName}`}
                            onOpenChange={(next) => setOpenToolDetailMenu(next ? `toolOverride:${toolKey.toolName}` : null)}
                            variant="selectable"
                            search={false}
                            selectedId={selected as any}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            trigger={({ open, toggle }) => (
                                <Item
                                    title={toolKey.title}
                                    subtitle={
                                        (() => {
                                            const key = TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.find((opt) => opt.key === selected)?.titleKey;
                                            return key ? tToolDetail(key) : String(selected);
                                        })()
                                    }
                                    icon={<Ionicons name="construct-outline" size={29} color={theme.colors.textSecondary} />}
                                    rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                                    onPress={toggle}
                                    showChevron={false}
                                    showDivider={showDivider}
                                    selected={false}
                                />
                            )}
                            items={TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.map((opt) => ({
                                id: opt.key,
                                title: tToolDetail(opt.titleKey),
                                subtitle: tToolDetail(opt.subtitleKey),
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="list-outline" size={22} color={theme.colors.textSecondary} />
                                    </View>
                                ),
                            }))}
                            onSelect={(id) => {
                                const next = id as ToolViewDetailLevel | 'default';
                                const current = (toolViewDetailLevelByToolName ?? {}) as Record<string, ToolViewDetailLevel>;
                                const nextRecord: Record<string, ToolViewDetailLevel> = { ...current };
                                if (next === 'default') {
                                    delete nextRecord[toolKey.toolName];
                                } else {
                                    nextRecord[toolKey.toolName] = next;
                                }
                                setToolViewDetailLevelByToolName(nextRecord as any);
                                setOpenToolDetailMenu(null);
                            }}
                        />
                    );
                })}
            </ItemGroup>
        </ItemList>
    );
});

export default ToolRenderingSettingsView;

