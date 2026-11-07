import * as React from 'react';

import { AutomationsLatestRunsSection } from '@/components/automations/home/AutomationsLatestRunsSection';
import type { IconName } from '@/components/ui/icons/Icon';
import type { WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { resolveWidgetInstanceTitle, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';
import { readWidgetGroupTitle } from '@/components/widgets/group/widgetGroupTitle';

import { HubAttentionSection } from './HubAttentionSection';
import { HomeCompletedBots } from './HomeCompletedBots';
import { HubComposerSection, type HubComposerSuggestionsPresentation } from './composer/HubComposerSection';
import { HubSetupSection } from './HubSetupSection';
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
    render: (input: Readonly<{
        menu: React.ReactNode;
        placeholder: string;
        frameStyle: WidgetFrameStyle;
        /** How the composer's suggestions stand here: Home decides it once, for the hero and for a moved composer. */
        composerSuggestions: HubComposerSuggestionsPresentation;
    }>) => React.ReactNode;
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
        // The real New Session composer; it keeps its own placeholder, as on `/new`. What Bots finished
        // while the person was away follows the composer wherever it is placed (the hero places it itself).
        render: ({ composerSuggestions }) => <>
            <HubComposerSection suggestions={composerSuggestions} />
            <HomeCompletedBots />
        </>,
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
]);

const BUILTIN_BY_ID: ReadonlyMap<string, HomeHubBuiltinSection> = new Map(
    HOME_HUB_BUILTIN_SECTIONS.map((section) => [section.id, section]),
);

export function findHomeHubBuiltinSection(id: string): HomeHubBuiltinSection | null {
    return BUILTIN_BY_ID.get(id) ?? null;
}

/** What a section is called in its menu and in Customize. */
export function homeHubSectionTitle(section: HomeHubSection<WidgetCandidate>): string {
    // The card's own name owner; a widget whose definition is gone is the kind word, never its instance id.
    if (section.kind === 'widget') return resolveWidgetInstanceTitle(section.instance, section.widget);
    // A group is its title, or (untitled) the names of its widgets.
    if (section.kind === 'group') return readWidgetGroupTitle(section.group) ?? section.children.map(homeHubSectionTitle).join(' · ');
    return findHomeHubBuiltinSection(section.id)?.title() ?? section.id;
}

/** What a widget or group is called on Home, for group names and menus. */
export function homeChildTitle(sections: readonly HomeHubSection<WidgetCandidate>[]) {
    return (instanceId: string): string => {
        for (const section of sections) {
            if (section.kind === 'widget' && section.id === instanceId) return homeHubSectionTitle(section);
            if (section.kind === 'group') {
                const child = section.children.find(entry => entry.id === instanceId);
                if (child) return homeHubSectionTitle(child);
            }
        }
        return resolveWidgetInstanceTitle(null, null);
    };
}
