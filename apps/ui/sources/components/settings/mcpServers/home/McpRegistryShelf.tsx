import * as React from 'react';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';

import { RegistryShelf, RegistryShelfAddControl, registryShelfProjection, resolveRegistryShelfUnavailable, type RegistryShelfCard } from '@/components/capabilities/add/RegistryShelf';
import { useRegistrySources } from '@/registries/useRegistrySources';
import type { useRegistrySuggestions } from '@/registries/useRegistrySuggestions';
import { t } from '@/text';

import type { McpHomeServer } from './mcpHomeModel';

/**
 * The registry's suggested servers (P4's one rule, IR-79: Happier picks, else the first page of the
 * built-in MCP registry) as the shared three-card shelf. A server already added reads Open.
 */
export const McpRegistryShelf = React.memo(function McpRegistryShelf(props: Readonly<{
    shelf: Pick<ReturnType<typeof useRegistrySuggestions>, 'items' | 'sourceId' | 'loading' | 'error' | 'status' | 'sourceFailures' | 'refresh'>;
    servers: readonly McpHomeServer[];
    onAdd: (card: RegistryShelfCard) => void;
    onOpen: (serverId: string) => void;
    /** The section's way into the whole registry (lab n:home "Browse all"): the Add modal's catalog on this source. */
    onBrowseAll?: () => void;
}>) {
    const sources = useRegistrySources('mcpServer');
    const sourceTitle = sources.sources.find((source) => source.id === props.shelf.sourceId)?.title ?? null;
    const { servers, onAdd, onOpen, shelf } = props;
    const unavailable = React.useMemo(
        () => resolveRegistryShelfUnavailable(shelf, (sourceId) => sources.sources.find((source) => source.id === sourceId)?.title),
        [shelf, sources.sources],
    );
    const addedId = React.useCallback((card: RegistryShelfCard) => servers.find((server) => {
        const origin = server.server.origin;
        return origin?.kind === 'registry' && origin.provenance.sourceId === card.sourceId && origin.provenance.itemId === card.itemId;
    })?.id ?? null, [servers]);
    const open = React.useCallback((card: RegistryShelfCard) => {
        const added = addedId(card);
        if (added) onOpen(added);
        else onAdd(card);
    }, [addedId, onAdd, onOpen]);
    // A card says its name and what it does; the registry's namespace id would only repeat the name (lab hm-A2).
    const where = React.useCallback(() => null, []);
    const glyph = React.useCallback((card: RegistryShelfCard) => <HappierBrandMark
        brand={card.brandMark ?? { displayName: card.title }} pixelSize={26} externallyLabelled />, []);
    // An added server reads Added; the card itself opens it.
    const action = React.useCallback((card: RegistryShelfCard) => (
        <RegistryShelfAddControl testID={`mcp.home.shelf.${card.itemId}`} state={addedId(card) ? 'added' : 'available'} title={card.title}
            addLabel={t('capabilities.mcpHome.shelfAdd')} addedLabel={t('capabilities.add.added')} failedLabel={t('capabilities.mcpHome.shelfAdd')}
            onAdd={() => onAdd(card)} />
    ), [addedId, onAdd]);
    return (
        <RegistryShelf
            projection={registryShelfProjection}
            testID="mcp.home.shelf"
            title={t('capabilities.mcpHome.shelfTitle')}
            {...(sourceTitle ? { description: t('capabilities.mcpHome.shelfFrom', { source: sourceTitle }) } : {})}
            items={props.shelf.items}
            loading={props.shelf.loading}
            {...(unavailable ? { unavailable } : {})}
            where={where}
            glyph={glyph}
            action={action}
            onOpen={open}
            columnTitle={t('settings.mcpServers')}
            {...(props.onBrowseAll ? { browseAll: { label: t('capabilities.skillsUpdates.shelf.browseAll'), onPress: props.onBrowseAll } } : {})}
        />
    );
});

