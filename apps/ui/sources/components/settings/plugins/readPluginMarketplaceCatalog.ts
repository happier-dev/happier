import { z } from 'zod';

export type PluginMarketplaceCatalogEntry = Readonly<{
    id: string;
    title: string;
    description: string | null;
    version: string | null;
}>;

export type PluginMarketplaceCatalog = Readonly<{
    sourceUrl: string;
    title: string;
    description: string | null;
    entries: readonly PluginMarketplaceCatalogEntry[];
}>;

const PluginMarketplaceCatalogEntrySchema = z.object({
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    version: z.string().trim().min(1).optional(),
}).passthrough();

const PluginMarketplaceCatalogDocumentSchema = z.object({
    t: z.literal('happier_plugin_marketplace_catalog_v1'),
    schemaVersion: z.literal(1),
    sourceUrl: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).nullable().optional(),
    entries: z.array(PluginMarketplaceCatalogEntrySchema).default([]),
}).passthrough();

function resolveEntryTitle(entry: z.infer<typeof PluginMarketplaceCatalogEntrySchema>): string {
    return entry.displayName ?? entry.title ?? entry.id;
}

export async function readPluginMarketplaceCatalog(sourceUrl: string): Promise<PluginMarketplaceCatalog> {
    const response = await fetch(sourceUrl, {
        headers: {
            accept: 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to load plugin catalog from ${sourceUrl}: ${response.status} ${response.statusText}`.trim());
    }

    const parsed = PluginMarketplaceCatalogDocumentSchema.safeParse(await response.json());
    if (!parsed.success) {
        throw new Error(`Plugin catalog from ${sourceUrl} is invalid`);
    }

    return {
        sourceUrl: parsed.data.sourceUrl,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        entries: parsed.data.entries.map((entry) => ({
            id: entry.id,
            title: resolveEntryTitle(entry),
            description: entry.description ?? null,
            version: entry.version ?? null,
        })),
    };
}
