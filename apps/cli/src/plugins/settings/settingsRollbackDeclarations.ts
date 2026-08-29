import { join } from 'node:path';

import {
    PluginSettingsContributionV2Schema,
    PluginSettingsRollbackDeclarationV1Schema,
    type PluginSettingsRollbackDeclarationV1,
} from '@happier-dev/protocol';

import { readPluginRegistryCommitRecord } from '../store/registry/commitRecord';
import type { PluginRegistryCommitRecord } from '../store/registry/commitRecord';
import {
    readPluginRegistryCommitInstallationAuthority,
    readPreparedImmutablePluginGeneration,
    type PluginInstallationStateRevision,
} from '../store/registry/generationStore';
import { resolvePluginStorePaths } from '../store/paths';
import { readPluginManifest } from '../manifest/read';
import { resolveNotificationChannelSettingsContributions } from './notificationChannelSettings';

/**
 * Canonical derivation of the one supported rollback Settings declaration per
 * `(pluginId, scope)` from the existing plugin generation support state
 * (SET-09 bounded rollback-retention rule).
 *
 * The exact retirement signal is the install registry's own retention state:
 * a `rollbackRetention` record whose bytes are `available` retains exactly one
 * prior generation, and the retained generation's canonically admitted manifest declares
 * which non-secret field IDs its Settings scope still owns. When the record is
 * gone, its bytes are explicitly no longer available, or the valid retained
 * manifest declares nothing for the scope, no rollback declaration exists.
 * Unreadable bytes are unknown and reject derivation; they never masquerade
 * as retirement. There is no history system, lineage ledger, or second registry.
 */
export type PluginSettingsRollbackDeclarations = ReadonlyMap<
    string,
    ReadonlyMap<
        'account' | 'daemon',
        PluginSettingsRollbackDeclarationV1
    >
>;

type RetainedScopeFieldIds = ReadonlyMap<'account' | 'daemon', readonly string[]>;

function isSecretSettingsField(field: { secret?: unknown }): boolean {
    return field.secret === true || (field.secret !== undefined && field.secret !== false);
}

/** Pure extraction of the rollback declaration's non-secret scope field ids. */
export function parseRetainedScopeFieldIds(params: Readonly<{
    pluginId: string;
    rawManifest: unknown;
}>): RetainedScopeFieldIds {
    const contributes = (
        params.rawManifest !== null
        && typeof params.rawManifest === 'object'
        && !Array.isArray(params.rawManifest)
    )
        ? (params.rawManifest as { contributes?: unknown }).contributes
        : null;
    if (contributes === null || typeof contributes !== 'object' || Array.isArray(contributes)) {
        throw new Error(`Retained manifest for '${params.pluginId}' has no valid contributes object`);
    }
    const rawSettings = (contributes as { settings?: unknown }).settings;
    const rawChannels = (contributes as { notificationChannels?: unknown }).notificationChannels;
    if (rawSettings !== undefined && !Array.isArray(rawSettings)) {
        throw new Error(`Retained manifest for '${params.pluginId}' has invalid Settings declarations`);
    }
    if (rawChannels !== undefined && !Array.isArray(rawChannels)) {
        throw new Error(`Retained manifest for '${params.pluginId}' has invalid notification-channel declarations`);
    }
    const contributions: unknown[] = [
        ...(Array.isArray(rawSettings) ? rawSettings : []),
        ...resolveNotificationChannelSettingsContributions(
            Array.isArray(rawChannels) ? rawChannels as never : [],
        ).map((entry) => entry.definition),
    ];
    const byScope = new Map<'account' | 'daemon', string[]>();
    for (const rawContribution of contributions) {
        const parsed = PluginSettingsContributionV2Schema.parse(rawContribution);
        const ids = byScope.get(parsed.scope) ?? [];
        for (const field of parsed.fields) {
            if (!isSecretSettingsField(field)) ids.push(field.id);
        }
        byScope.set(parsed.scope, ids);
    }
    return new Map(
        [...byScope.entries()].map(([scope, ids]) => [scope, Object.freeze([...new Set(ids)].sort())]),
    );
}

/**
 * Pure derivation over the exact installation revision. `readRetainedManifest`
 * supplies the retained generation's canonically admitted manifest. Failure
 * to read or validate bytes is unknown support state and rejects the whole
 * derivation; it is never reinterpreted as artifact retirement.
 */
export async function derivePluginSettingsRollbackDeclarations(params: Readonly<{
    revision: Pick<PluginInstallationStateRevision, 'rollbackRetention'>;
    readRetainedManifest: (retention: PluginInstallationStateRevision['rollbackRetention'][number])
        => Promise<unknown>;
}>): Promise<PluginSettingsRollbackDeclarations> {
    const declarations = new Map<string, Map<'account' | 'daemon', PluginSettingsRollbackDeclarationV1>>();
    for (const retention of params.revision.rollbackRetention) {
        // `available` is the exact existing support state: a retention record
        // whose bytes are missing/corrupt/evicted/source-ineligible no longer
        // supports a rollback, so nothing stays owned through it.
        if (retention.byteAvailability !== 'available') continue;
        const rawManifest = await params.readRetainedManifest(retention);
        const scopeFieldIds = parseRetainedScopeFieldIds({ pluginId: retention.pluginId, rawManifest });
        if (scopeFieldIds.size === 0) continue;
        const byScope = declarations.get(retention.pluginId)
            ?? new Map<'account' | 'daemon', PluginSettingsRollbackDeclarationV1>();
        for (const [scope, fieldIds] of scopeFieldIds) {
            const declaration = PluginSettingsRollbackDeclarationV1Schema.parse({
                generation: retention.immutableGenerationId,
                supported: true,
                fieldIds,
            });
            if (byScope.has(scope)) {
                // The existing registry schema admits one retained generation
                // per plugin. A duplicate is unknown/corrupt authority, never
                // a synthetic `supported:false` retirement declaration.
                throw new Error(`Multiple rollback generations claim '${retention.pluginId}' Settings scope '${scope}'`);
            }
            byScope.set(scope, declaration);
        }
        declarations.set(retention.pluginId, byScope);
    }
    return declarations;
}

export async function readPluginSettingsRollbackDeclarations(params: Readonly<{
    happyHomeDir?: string;
    /** Exact commit already selected by the runtime generation authority. */
    commit?: PluginRegistryCommitRecord | null;
}>): Promise<PluginSettingsRollbackDeclarations> {
    const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
    const commit = Object.hasOwn(params, 'commit')
        ? params.commit ?? null
        : await readPluginRegistryCommitRecord(paths);
    if (!commit) return new Map();
    const revision = await readPluginRegistryCommitInstallationAuthority(paths, commit);
    // A selected commit without its exact installation authority is unknown,
    // not an authoritative empty rollback set. Let the registry resolver turn
    // this failure into `undefined`, which preserves every removed value.
    if (!revision) {
        throw new Error('Plugin rollback Settings authority is unavailable for the selected registry commit');
    }
    return await derivePluginSettingsRollbackDeclarations({
        revision,
        readRetainedManifest: async (retention) => {
            const prepared = await readPreparedImmutablePluginGeneration({
                paths,
                immutableGenerationId: retention.immutableGenerationId,
            });
            if (prepared.record.pluginId !== retention.pluginId) {
                throw new Error(`Rollback generation identity mismatch for '${retention.pluginId}'`);
            }
            const loaded = await readPluginManifest({
                manifestPath: join(
                    prepared.rootPath,
                    ...prepared.record.manifestRelativePath.split('/'),
                ),
                manifestAuthority: 'external',
                sourceProvenance: prepared.record.sourceProvenance,
            });
            if (!loaded.ok) {
                throw new Error(`Rollback manifest for '${retention.pluginId}' is not loadable`);
            }
            if (loaded.manifest.id !== retention.pluginId) {
                throw new Error(`Rollback manifest identity mismatch for '${retention.pluginId}'`);
            }
            return loaded.manifest;
        },
    });
}
