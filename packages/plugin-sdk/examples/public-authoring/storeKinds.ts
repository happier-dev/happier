import { createPluginStoreItemHref, definePlugin, PluginStoreItemV1ProtocolSchema, type PluginStoreItemV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

const request = defineProtocolObject({ query: defineProtocolString().optional() }, { policy: 'closed' });
const link = defineProtocolObject({ url: defineProtocolString() }, { policy: 'closed' });
const palette = defineProtocolObject({ background: defineProtocolString() }, { policy: 'closed' });
const items = defineProtocolArray(PluginStoreItemV1ProtocolSchema);

/** One static item demonstrates ordinary Store navigation and lifecycle Actions.
 * The supplied port is persistent storage; query/read/installed handlers remain plugin-owned. */
export function createExternalStoreKind(storage: Readonly<{
    read(): Promise<PluginStoreItemV1 | null>;
    write(item: PluginStoreItemV1): Promise<void>;
    remove(): Promise<void>;
}>) {
    const ocean: PluginStoreItemV1 = { sourceId: 'community', itemId: 'ocean', version: '1', title: 'Ocean',
        description: 'A blue theme', value: { background: '#123456' } };
    const safe = { scopes: ['machine'] as const, surfaces: ['plugin'] as const,
        execution: { target: 'daemon' as const }, dangerLevel: 'safe' as const, readOnly: true };
    const mutation = { scopes: ['machine'] as const, surfaces: ['plugin'] as const,
        execution: { target: 'daemon' as const }, dangerLevel: 'writesLocal' as const };
    return definePlugin({ id: 'com.example.store', version: '1.0.0', displayName: 'External theme Store',
        storeKinds: { theme: { title: 'Themes', viewId: 'store', operations: {
            list: 'list', read: 'read', installed: 'installed', prepare: 'prepare', acquire: 'acquire', manage: 'manage',
        } } },
        ui: { renderers: [{ id: 'catalog', kind: 'declarative', root: { kind: 'stack', children: [
            { kind: 'action', label: 'Open Ocean listing', hostAction: 'workspace.tabs.open', input: {
                href: createPluginStoreItemHref({ type: 'storeKind', kind: 'com.example.store/theme',
                    sourceId: ocean.sourceId, itemId: ocean.itemId, version: ocean.version }),
            } },
            { kind: 'list', label: 'Themes', children: [{ kind: 'item', title: 'Ocean', subtitle: 'A blue theme',
                action: 'read', input: { url: 'theme://community/ocean' } }] },
            { kind: 'actionPanel', children: [
                { kind: 'action', label: 'Prepare Ocean', action: 'prepare', input: ocean },
                { kind: 'action', label: 'Apply Ocean', action: 'acquire', input: ocean },
                { kind: 'action', label: 'Installed themes', action: 'installed', input: {} },
                { kind: 'action', label: 'Remove Ocean', action: 'manage', input: {}, variant: 'destructive' },
            ] },
        ] } }],
            views: [{ id: 'store', title: 'Themes', renderer: 'catalog', container: 'appPage', target: { kind: 'app' } }] },
        actions: {
            list: { ...safe, title: 'Find themes', inputSchema: request, resultSchema: items,
                run: async value => { const { query } = request.parse(value);
                    return !query || 'ocean'.includes(query.toLowerCase()) ? [ocean] : []; } },
            read: { ...safe, title: 'Read theme link', inputSchema: link, resultSchema: PluginStoreItemV1ProtocolSchema,
                run: async value => { const url = new URL(link.parse(value).url);
                    if (url.protocol !== 'theme:' || url.hostname !== 'community' || url.pathname !== '/ocean') throw new Error('Unknown theme');
                    return ocean; } },
            installed: { ...safe, title: 'Installed themes', inputSchema: request, resultSchema: items,
                run: async () => { const item = await storage.read(); return item ? [{ ...item, installed: true }] : []; } },
            prepare: { ...safe, title: 'Prepare theme', inputSchema: PluginStoreItemV1ProtocolSchema, resultSchema: PluginStoreItemV1ProtocolSchema,
                run: async value => { const item = PluginStoreItemV1ProtocolSchema.parse(value);
                    const prepared = palette.safeParse(item.value);
                    if (!prepared.success) throw prepared.error;
                    return { ...item, value: prepared.data }; } },
            acquire: { ...mutation, title: 'Apply theme', inputSchema: PluginStoreItemV1ProtocolSchema, resultSchema: PluginStoreItemV1ProtocolSchema,
                confirmation: { title: 'Apply theme?', body: 'Save this theme as the installed theme.',
                    inputFields: [{ path: 'title', title: 'Theme' }] },
                run: async value => { const item = PluginStoreItemV1ProtocolSchema.parse(value);
                    await storage.write(item); return { ...item, installed: true }; } },
            manage: { ...mutation, title: 'Remove theme', inputSchema: request, resultSchema: items,
                confirmation: { title: 'Remove installed theme?', body: 'Remove the theme saved by this plugin.' },
                run: async () => { await storage.remove(); return []; } },
        },
    });
}
