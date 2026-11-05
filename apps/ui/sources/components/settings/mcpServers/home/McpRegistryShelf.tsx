import * as React from 'react';
import { Image } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RegistryShelf, RegistryShelfAddControl, registryShelfProjection, type RegistryShelfCard } from '@/components/capabilities/add/RegistryShelf';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { t } from '@/text';

import type { McpHomeServer } from './mcpHomeModel';

/**
 * The registry's suggested servers (P4's one rule, IR-79: Happier picks, else the first page of the
 * built-in MCP registry) as the shared three-card shelf. A server already added reads Open.
 */
export const McpRegistryShelf = React.memo(function McpRegistryShelf(props: Readonly<{
    shelf: Readonly<{ items: readonly RegistryShelfCard[]; sourceId: string | null; loading: boolean }>;
    servers: readonly McpHomeServer[];
    onAdd: (card: RegistryShelfCard) => void;
    onOpen: (serverId: string) => void;
}>) {
    const sources = useRegistrySources('mcpServer');
    const sourceTitle = sources.sources.find((source) => source.id === props.shelf.sourceId)?.title ?? null;
    const { servers, onAdd, onOpen } = props;
    const addedId = React.useCallback((card: RegistryShelfCard) => servers.find((server) => {
        const origin = server.server.origin;
        return origin?.kind === 'registry' && origin.provenance.sourceId === card.sourceId && origin.provenance.itemId === card.itemId;
    })?.id ?? null, [servers]);
    const open = React.useCallback((card: RegistryShelfCard) => {
        const added = addedId(card);
        if (added) onOpen(added);
        else onAdd(card);
    }, [addedId, onAdd, onOpen]);
    // The publisher, unless it only repeats the name ("Notion" by Notion).
    const where = React.useCallback((card: RegistryShelfCard) => (card.publisher && card.publisher.name !== card.title ? card.publisher.name : null), []);
    const glyph = React.useCallback((card: RegistryShelfCard) => (card.iconUrl
        ? <Image source={{ uri: card.iconUrl }} style={styles.mark} accessibilityIgnoresInvertColors />
        : null), []);
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
            where={where}
            glyph={glyph}
            action={action}
            onOpen={open}
            columnTitle={t('settings.mcpServers')}
        />
    );
});

const styles = StyleSheet.create(() => ({
    mark: { width: 26, height: 26 },
}));
