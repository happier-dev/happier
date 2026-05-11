import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
    TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS,
    TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS,
    type ToolViewDetailLevel,
} from '@/components/settings/session/toolRendering/toolRenderingSettingOptions';
import { TOOL_RENDERING_OVERRIDE_ENTRIES } from '@/components/settings/session/toolRendering/toolRenderingOverrideEntries';

export const ToolRenderingSettingsView = React.memo(function ToolRenderingSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);

    const [toolViewDetailLevelByToolName, setToolViewDetailLevelByToolName] = useSettingMutable('toolViewDetailLevelByToolName');
    const [toolViewExpandedDetailLevelByToolName, setToolViewExpandedDetailLevelByToolName] = useSettingMutable('toolViewExpandedDetailLevelByToolName');

    const [openToolDetailMenu, setOpenToolDetailMenu] = React.useState<null | string>(null);
    const tToolDetail = t as (key: any) => string;

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.toolDetailOverrides.title')}
                footer={t('settingsSession.toolDetailOverrides.footer')}
            >
                {TOOL_RENDERING_OVERRIDE_ENTRIES.map((toolKey, index) => {
                    const override = (toolViewDetailLevelByToolName as any)?.[toolKey.toolName] as ToolViewDetailLevel | undefined;
                    const selected = override ?? 'default';
                    const showDivider = index < TOOL_RENDERING_OVERRIDE_ENTRIES.length - 1;

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
                            itemTrigger={{
                                title: toolKey.title,
                                icon: <Ionicons name="construct-outline" size={29} color={theme.colors.text.secondary} />,
                                subtitle: (() => {
                                    const key = TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.find((opt) => opt.key === selected)?.titleKey;
                                    return key ? tToolDetail(key) : String(selected);
                                })(),
                                itemProps: { showDivider },
                            }}
                            items={TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.map((opt) => ({
                                id: opt.key,
                                title: tToolDetail(opt.titleKey),
                                subtitle: tToolDetail(opt.subtitleKey),
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="list-outline" size={22} color={theme.colors.text.secondary} />
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

            <ItemGroup
                title={t('settingsSession.toolDetailOverrides.expandedTitle')}
                footer={t('settingsSession.toolDetailOverrides.expandedFooter')}
            >
                {TOOL_RENDERING_OVERRIDE_ENTRIES.map((toolKey, index) => {
                    const override = (toolViewExpandedDetailLevelByToolName as any)?.[toolKey.toolName] as 'summary' | 'full' | undefined;
                    const selected = override ?? 'default';
                    const showDivider = index < TOOL_RENDERING_OVERRIDE_ENTRIES.length - 1;

                    return (
                        <DropdownMenu
                            key={toolKey.toolName}
                            open={openToolDetailMenu === `toolExpandedOverride:${toolKey.toolName}`}
                            onOpenChange={(next) => setOpenToolDetailMenu(next ? `toolExpandedOverride:${toolKey.toolName}` : null)}
                            variant="selectable"
                            search={false}
                            selectedId={selected as any}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            itemTrigger={{
                                title: toolKey.title,
                                icon: <Ionicons name="expand-outline" size={29} color={theme.colors.text.secondary} />,
                                subtitle: (() => {
                                    const key = TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.find((opt) => opt.key === selected)?.titleKey;
                                    return key ? tToolDetail(key) : String(selected);
                                })(),
                                itemProps: { showDivider },
                            }}
                            items={TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.map((opt) => ({
                                id: opt.key,
                                title: tToolDetail(opt.titleKey),
                                subtitle: tToolDetail(opt.subtitleKey),
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="expand-outline" size={22} color={theme.colors.text.secondary} />
                                    </View>
                                ),
                            }))}
                            onSelect={(id) => {
                                const next = id as 'default' | 'summary' | 'full';
                                const current = (toolViewExpandedDetailLevelByToolName ?? {}) as Record<string, 'summary' | 'full'>;
                                const nextRecord: Record<string, 'summary' | 'full'> = { ...current };
                                if (next === 'default') {
                                    delete nextRecord[toolKey.toolName];
                                } else {
                                    nextRecord[toolKey.toolName] = next;
                                }
                                setToolViewExpandedDetailLevelByToolName(nextRecord as any);
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
