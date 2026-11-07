import type { ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ProviderConnectionId } from '@happier-dev/protocol/providers/ids';

type Connection = ProviderConnectionsCatalogV1['connections'][number];
type Model = ProviderConnectionsCatalogV1['manualModelsByConnectionId'][ProviderConnectionId][number];
type ScopeReferences = Readonly<{
    connections: ReadonlyMap<string, Connection>;
    models: ReadonlyMap<string, ReadonlyMap<string, Model>>;
}>;

/** Exact presentation facts materialized by the Account catalog's existing publication owner. */
export class ProviderCatalogReferences {
    private readonly scopes = new Map<string, ScopeReferences>();

    connection(scopeKey: string, connectionId: string): Connection | null {
        return this.scopes.get(scopeKey)?.connections.get(connectionId) ?? null;
    }

    model(scopeKey: string, connectionId: string, modelId: string): Model | null {
        return this.scopes.get(scopeKey)?.models.get(connectionId)?.get(modelId) ?? null;
    }

    apply(scopeKey: string, catalog: ProviderConnectionsCatalogV1 | null): void {
        if (!catalog) { this.scopes.delete(scopeKey); return; }
        const connections = new Map<string, Connection>();
        for (const connection of catalog.connections) {
            connections.set(connection.id, connection);
        }
        const models = new Map<string, ReadonlyMap<string, Model>>();
        for (const [connectionId, rows] of Object.entries(catalog.manualModelsByConnectionId)) {
            const selected = new Map<string, Model>();
            for (const model of rows) {
                selected.set(model.id, model);
            }
            models.set(connectionId, selected);
        }
        this.scopes.set(scopeKey, { connections, models });
    }

    clear(): void { this.scopes.clear(); }
}
