import * as React from 'react';

import { AutomationsLatestRunsSection } from '@/components/automations/home/AutomationsLatestRunsSection';
import type { IconName } from '@/components/ui/icons/Icon';
import type { WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';

import { HubAttentionSection } from './HubAttentionSection';
import { HubComposerSection } from './composer/HubComposerSection';
import { HubMachinesSection } from './HubMachinesSection';
import { HubSetupSection } from './HubSetupSection';
import { UsageCapacitySection } from '@/components/settings/usage/UsageCapacitySection';
import { HOME_HUB_BUILTIN_DEFINITIONS, type HomeHubBuiltinDefinition, type HomeHubSection } from './layout/homeHubLayout';
export { isHomeHubCardSection } from './layout/homeHubLayout';

/**
 * The app home's built-in sections, in their default order: the one table the home, its section
 * menu and Customize read. A new built-in section (Automations' or Workflows' latest runs) is one
 * row here. Plugin widgets are not rows: they join the same list from the installed widget
 * inventory.
 */
export type HomeHubBuiltinSection = HomeHubBuiltinDefinition & Readonly<{
    title: () => string;
    /** Customize names each section with a glyph and where it comes from. */
    icon: IconName;
    description: () => string;
    render: (input: Readonly<{ menu: React.ReactNode; placeholder: string; frameStyle: WidgetFrameStyle }>) => React.ReactNode;
}>;

const builtin = (id: string): HomeHubBuiltinDefinition => {
    const definition = HOME_HUB_BUILTIN_DEFINITIONS.find(section => section.id === id);
    if (!definition) throw new Error(`Unknown Home builtin: ${id}`);
    return definition;
};
export const HOME_HUB_BUILTIN_SECTIONS: readonly HomeHubBuiltinSection[] = Object.freeze([
    {
        ...builtin('start'),
        icon: 'arrow-up',
        description: () => t('homeIndex.startDescription'),
        title: () => t('settingsOverview.homeStartSection'),
        // The real New Session composer; it keeps its own placeholder, as on `/new`.
        render: () => <HubComposerSection />,
    },
    {
        ...builtin('attention'),
        icon: 'bell',
        description: () => t('homeIndex.attentionDescription'),
        title: () => t('settingsOverview.attentionTitle'),
        render: ({ menu }) => <HubAttentionSection menu={menu} />,
    },
    {
        ...builtin('setup'),
        icon: 'check-circle',
        description: () => t('homeIndex.builtIn'),
        title: () => t('settingsOverview.setupTitle'),
        render: ({ menu }) => <HubSetupSection menu={menu} />,
    },
    {
        ...builtin('automations'),
        icon: 'timer',
        description: () => t('navigation.automations'),
        title: () => t('homeWidgets.latestRunsTitle'),
        render: ({ menu, frameStyle }) => <AutomationsLatestRunsSection menu={menu} frameStyle={frameStyle} />,
    },
    {
        ...builtin('machines'),
        icon: 'desktop',
        description: () => t('homeIndex.machinesDescription'),
        // Off until turned on in Customize; shown, it is a grid of the machines.
        title: () => t('settingsOverview.machinesTitle'),
        render: ({ menu }) => <HubMachinesSection menu={menu} />,
    },
    {
        ...builtin('usage'),
        icon: 'speedometer',
        description: () => t('homeIndex.builtIn'),
        title: () => t('settingsOverview.usageTitle'),
        render: ({ menu }) => <UsageCapacitySection menu={menu} />,
    },
]);

const BUILTIN_BY_ID: ReadonlyMap<string, HomeHubBuiltinSection> = new Map(
    HOME_HUB_BUILTIN_SECTIONS.map((section) => [section.id, section]),
);

export function findHomeHubBuiltinSection(id: string): HomeHubBuiltinSection | null {
    return BUILTIN_BY_ID.get(id) ?? null;
}

/** What a section is called in its menu and in Customize. */
export function homeHubSectionTitle(section: HomeHubSection<WidgetCandidate>): string {
    if (section.kind === 'widget') return section.instance.displayName ?? section.widget?.title ?? section.instance.id;
    // A group is its title, or (untitled) the names of its widgets.
    if (section.kind === 'group') return section.group.title ?? section.children.map(homeHubSectionTitle).join(' · ');
    return findHomeHubBuiltinSection(section.id)?.title() ?? section.id;
}
