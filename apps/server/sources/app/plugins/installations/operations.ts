import { isReservedHappierPluginId } from "@happier-dev/protocol";
import type {
    PluginInstallationManifestDeleteActionInputV1,
    PluginInstallationManifestDeleteActionOutputV1,
    PluginInstallationManifestListActionInputV1,
    PluginInstallationManifestListActionOutputV1,
    PluginInstallationManifestUpsertActionInputV1,
    PluginInstallationManifestUpsertActionOutputV1,
} from "@happier-dev/protocol";
import {
    PluginInstallationManifestDeleteActionOutputV1Schema,
    PluginInstallationManifestListActionOutputV1Schema,
    PluginInstallationManifestUpsertActionOutputV1Schema,
} from "@happier-dev/protocol";

import { PluginInstallationManifestOperationError } from "./errors";
import {
    createSqlPluginInstallationManifestProjectionStore,
    type PluginInstallationManifestProjectionStore,
} from "./storage";

export type PluginInstallationManifestOperationsRuntime = Readonly<{
    now: () => number;
}>;

export type PluginInstallationManifestOperations = Readonly<{
    list(params: Readonly<{
        accountId: string;
        input: PluginInstallationManifestListActionInputV1;
    }>): Promise<PluginInstallationManifestListActionOutputV1>;
    upsert(params: Readonly<{
        accountId: string;
        machineId: string;
        input: PluginInstallationManifestUpsertActionInputV1;
    }>): Promise<PluginInstallationManifestUpsertActionOutputV1>;
    delete(params: Readonly<{
        accountId: string;
        machineId: string;
        input: PluginInstallationManifestDeleteActionInputV1;
    }>): Promise<PluginInstallationManifestDeleteActionOutputV1>;
}>;

function defaultRuntime(): PluginInstallationManifestOperationsRuntime {
    return { now: () => Date.now() };
}

function assertExternalPluginProjection(pluginId: string): void {
    if (isReservedHappierPluginId(pluginId)) {
        throw new PluginInstallationManifestOperationError(
            "plugin_installation_manifest_reserved_plugin_id",
            "External installed plugin projections cannot use reserved Happier plugin ids",
        );
    }
}

export function createPluginInstallationManifestOperations(
    store: PluginInstallationManifestProjectionStore = createSqlPluginInstallationManifestProjectionStore(),
    runtime: PluginInstallationManifestOperationsRuntime = defaultRuntime(),
): PluginInstallationManifestOperations {
    return {
        async list(params) {
            const manifests = await store.list({
                accountId: params.accountId,
                machineId: params.input.machineId,
                pluginId: params.input.pluginId,
                includeDisabled: params.input.includeDisabled,
                limit: params.input.limit,
            });
            return PluginInstallationManifestListActionOutputV1Schema.parse({ manifests });
        },
        async upsert(params) {
            assertExternalPluginProjection(params.input.pluginId);
            const manifest = await store.upsert({
                accountId: params.accountId,
                machineId: params.machineId,
                input: params.input,
                now: runtime.now(),
            });
            return PluginInstallationManifestUpsertActionOutputV1Schema.parse({ manifest });
        },
        async delete(params) {
            assertExternalPluginProjection(params.input.pluginId);
            const deleted = await store.delete({
                accountId: params.accountId,
                machineId: params.machineId,
                pluginId: params.input.pluginId,
            });
            return PluginInstallationManifestDeleteActionOutputV1Schema.parse({
                pluginId: params.input.pluginId,
                deleted,
            });
        },
    };
}
