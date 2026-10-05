import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';

/** The glyph of a plugin that has no logo of its own. */
export const PLUGIN_GLYPH = 'puzzle-piece' as const;

/**
 * A plugin's identity mark, the same in the Plugins column, the grid, the list and the plugin's own
 * header: the logo of the Agent it contributes when that Agent has one (the projection's
 * `iconAgentId`, resolved by `resolveAgentMarkAgentId`), otherwise the neutral plugin glyph. Plugin
 * records carry no admitted logo, so there is no letter or tint to invent.
 *
 * `row` (lists, cards, the column) is the bare mark in the Collection's mark box: no tile behind a
 * logo or a glyph. `page` heads the plugin's detail through the same bare header-mark slot.
 */
export const PluginMark = React.memo(function PluginMark(props: Readonly<{
    title: string;
    /** The Agent this plugin contributes, when it has a known mark (projection `iconAgentId`). */
    iconAgentId?: string | null;
    size?: 'row' | 'page';
    dimmed?: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const page = props.size === 'page';
    const logo = props.iconAgentId && hasAgentIconMark(props.iconAgentId, theme) ? props.iconAgentId : null;
    if (page) {
        return logo ? (
            <PageHeaderMarkSlot testID={props.testID} size="page">
                <AgentIcon agentId={logo} size={28} />
            </PageHeaderMarkSlot>
        ) : (
            <PageHeaderMarkSlot testID={props.testID} size="page">
                <Icon name={PLUGIN_GLYPH} size={24} color={theme.colors.text.secondary} />
            </PageHeaderMarkSlot>
        );
    }
    return (
        <HappierCollectionListMark {...(props.dimmed ? { dimmed: true } : {})}>
            {logo ? (
                <AgentIcon agentId={logo} size={20} />
            ) : (
                <Icon testID={props.testID} name={PLUGIN_GLYPH} size={20} color={theme.colors.text.secondary} />
            )}
        </HappierCollectionListMark>
    );
});
