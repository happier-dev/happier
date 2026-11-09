import type { AgentUiBehavior } from './registryUiBehavior';
import { createAgentUiBehaviorFromDescriptor } from './agentUiBehaviorDescriptors';
import { isRecord, type UiProjectionDiagnostic } from './uiDescriptorDiagnostics';
import {
    captureActiveServerAccountScopeCurrentness,
    getActiveServerAccountScope,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    resolvePluginUiTranslationText,
} from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

/**
 * The runtime input to agent UI behavior: the `plugin.ui.v1` behavior
 * descriptor an installed Agent ships, delivered by the daemon contribution
 * registry projection instead of baked in at build time.
 *
 * This is the same descriptor language the bundled generator emits, read by
 * the same pure fail-closed interpreter (`createAgentUiBehaviorFromDescriptor`).
 * There is deliberately no second interpreter and no second behavior shape:
 * an external Agent's descriptor is projected exactly like a bundled one, so
 * an Agent that ships a descriptor is never degraded to the neutral unknown
 * fallback merely because it is not one of the bundled ids.
 *
 * A descriptor is a fact of one MACHINE inside one ACCOUNT, and this store
 * keys it that way:
 *
 * - **Account.** The producer carries the source Home's authenticated Account
 *   scope. Explicitly routed Homes may coexist while another Home is active;
 *   their descriptors must not be stamped with that active Home's identity.
 *   Request lifetime retirement prevents late responses from republishing.
 * - **Machine.** Two machines can hold different versions of the same Agent
 *   and therefore different descriptors. A caller that knows which machine
 *   owns the render reads that machine's descriptor and nothing else, so a
 *   Session on machine B can never render with machine A's declaration.
 */
export type ProjectedAgentUiBehaviorDescriptor = Readonly<Record<string, unknown>>;

export type ProjectedAgentUiBehaviorEntry = Readonly<{
    /** Stable identity of the published descriptor, usable as a memo key. */
    descriptor: ProjectedAgentUiBehaviorDescriptor;
    behavior: AgentUiBehavior;
    diagnostics: readonly UiProjectionDiagnostic[];
}>;

/** One published descriptor, interpreted at most once while it stays published. */
type PublishedDescriptor = {
    readonly descriptor: ProjectedAgentUiBehaviorDescriptor;
    readonly pluginUiProjection: PluginUiProjectionModel | null;
    readonly locale: string | null;
    interpreted: ProjectedAgentUiBehaviorEntry | null;
};

type PublishedMachineSet = Readonly<{
    accountScopeKey: string;
    currentness: Pick<ActiveServerAccountScopeLifetime, 'isCurrent'>;
    machineId: string;
    descriptorsByAgentId: ReadonlyMap<string, PublishedDescriptor>;
}>;

/**
 * The scope key used when no Account scope is active. Production publishes
 * happen inside an active Account, so this bucket is only ever reachable by a
 * direct unit composition; it can never be read once a real Account mounts.
 */
const NO_ACCOUNT_SCOPE_KEY = '\0no-account-scope';

const PUBLISHED_BY_SCOPE = new Map<string, PublishedMachineSet>();

function accountScopeKey(scope: ServerAccountScope | null | undefined): string | null {
    if (scope === null) return null;
    const resolved = scope ?? getActiveServerAccountScope();
    return resolved ? serverAccountScopeKeySuffix({
        ...resolved,
        serverId: resolveServerProfileScopeIdForIdentifier(resolved.serverId),
    }) : NO_ACCOUNT_SCOPE_KEY;
}

function publishedSetKey(accountScopeKey: string, machineId: string): string {
    return `${accountScopeKey}\0${machineId}`;
}

function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Replaces the descriptor set one machine's daemon projection contributes.
 * A machine that publishes no descriptor drops its previous set, so a plugin
 * uninstalled on that machine stops projecting behavior for it.
 *
 * Publishing reclaims retired request lifetimes, not other routed Homes that
 * remain usable alongside the active Home.
 */
export function publishProjectedAgentUiBehaviorDescriptors(params: Readonly<{
    machineId: string;
    accountScope?: ServerAccountScope | null;
    accountLifetime?: Pick<ActiveServerAccountScopeLifetime, 'isCurrent'> | null;
    descriptorsByAgentId: Readonly<Record<string, unknown>>;
    pluginUiProjection?: PluginUiProjectionModel | null;
    locale?: string | null;
}>): void {
    const machineId = normalizeId(params.machineId);
    if (!machineId) return;
    if (params.accountLifetime && !params.accountLifetime.isCurrent()) return;
    const scopeKey = accountScopeKey(params.accountScope);
    if (scopeKey === null) return;
    const currentness = params.accountLifetime ?? captureActiveServerAccountScopeCurrentness();
    for (const [key, set] of [...PUBLISHED_BY_SCOPE]) {
        if (!set.currentness.isCurrent()) PUBLISHED_BY_SCOPE.delete(key);
    }

    const published = new Map<string, PublishedDescriptor>();
    for (const [rawAgentId, descriptor] of Object.entries(params.descriptorsByAgentId)) {
        const agentId = normalizeId(rawAgentId);
        if (!agentId || !isRecord(descriptor)) continue;
        published.set(agentId, {
            descriptor,
            pluginUiProjection: params.pluginUiProjection ?? null,
            locale: normalizeId(params.locale) || null,
            interpreted: null,
        });
    }

    const key = publishedSetKey(scopeKey, machineId);
    if (published.size === 0) {
        PUBLISHED_BY_SCOPE.delete(key);
        return;
    }
    PUBLISHED_BY_SCOPE.set(key, Object.freeze({
        accountScopeKey: scopeKey,
        currentness,
        machineId,
        descriptorsByAgentId: published,
    }));
}

export function clearProjectedAgentUiBehaviorDescriptors(): void {
    PUBLISHED_BY_SCOPE.clear();
}

function readScopeSets(scopeKey: string): readonly PublishedMachineSet[] {
    return [...PUBLISHED_BY_SCOPE.values()].filter((set) => (
        set.accountScopeKey === scopeKey && set.currentness.isCurrent()
    ));
}

/** Metadata consumers enumerate only the current Account's already-published declarations. */
export function listProjectedAgentUiBehaviorIds(accountScope?: ServerAccountScope | null): readonly string[] {
    const scopeKey = accountScopeKey(accountScope);
    if (scopeKey === null) return [];
    return [...new Set(readScopeSets(scopeKey).flatMap(set => [...set.descriptorsByAgentId.keys()]))].sort();
}

function readPublishedDescriptor(
    agentId: string,
    machineId: string | null,
    scopeKey: string,
): PublishedDescriptor | null {
    if (machineId) {
        // A caller that knows the owning machine gets that machine's answer or
        // none. Falling back to another machine's declaration is exactly the
        // cross-device defect this scoping exists to remove; the neutral
        // unknown floor is the correct answer until this machine describes.
        const set = PUBLISHED_BY_SCOPE.get(publishedSetKey(scopeKey, machineId));
        return set?.currentness.isCurrent() ? set.descriptorsByAgentId.get(agentId) ?? null : null;
    }
    // The machine-blind floor. It is reached only by callers with no machine in
    // hand (agent settings, cross-agent ordering), where every machine's
    // descriptor is equally applicable; the order is fixed by machine id purely
    // so a render never flips on fetch order.
    let owningMachineId: string | null = null;
    let published: PublishedDescriptor | null = null;
    for (const set of readScopeSets(scopeKey)) {
        const candidate = set.descriptorsByAgentId.get(agentId);
        if (!candidate) continue;
        if (owningMachineId === null || set.machineId < owningMachineId) {
            owningMachineId = set.machineId;
            published = candidate;
        }
    }
    return published;
}

function interpret(agentId: string, published: PublishedDescriptor): ProjectedAgentUiBehaviorEntry {
    if (!published.interpreted) {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor(
            published.descriptor,
            agentId,
            published.pluginUiProjection
                ? {
                    resolvePluginTranslation: (pluginId, key) => resolvePluginUiTranslationText({
                        projection: published.pluginUiProjection,
                        pluginId,
                        key,
                        locale: published.locale,
                    }),
                }
                : undefined,
        );
        published.interpreted = Object.freeze({ descriptor: published.descriptor, behavior, diagnostics });
    }
    return published.interpreted;
}

/**
 * Reads the interpreted descriptor an installed Agent projected, or `null`
 * when the requested scope projected none. The entry is interpreted once and
 * retained, so repeated reads stay referentially stable for React consumers.
 */
export function resolveProjectedAgentUiBehaviorEntry(
    agentId: string | null | undefined,
    machineId?: string | null,
    accountScope?: ServerAccountScope | null,
): ProjectedAgentUiBehaviorEntry | null {
    const normalizedAgentId = normalizeId(agentId);
    if (!normalizedAgentId) return null;
    const scopeKey = accountScopeKey(accountScope);
    if (scopeKey === null) return null;
    const published = readPublishedDescriptor(normalizedAgentId, normalizeId(machineId) || null, scopeKey);
    return published ? interpret(normalizedAgentId, published) : null;
}

export type ProjectedAgentUiBehaviorDiagnostic = UiProjectionDiagnostic & Readonly<{
    agentId: string;
    /**
     * The plugin that authored the descriptor, taken from the descriptor the
     * daemon projection published. Author feedback is attributed per plugin, so
     * a per-plugin surface never shows one author another author's refusal.
     */
    pluginId: string;
}>;

/**
 * Every fail-closed diagnostic the descriptor interpreter produced for the
 * Agents one machine projected.
 *
 * A bundled Agent's descriptor is generated at build time behind a generator
 * test, so a malformed field is caught in CI. An external Agent's identical
 * field is interpreted at runtime, and without this read its refusal would be
 * invisible: the contribution would silently no-op and the author would see a
 * working plugin that does nothing. This is the delivery half of that
 * interpreter, not a second one.
 */
export function readProjectedAgentUiBehaviorDiagnostics(
    machineId: string | null | undefined,
    accountScope?: ServerAccountScope | null,
): readonly ProjectedAgentUiBehaviorDiagnostic[] {
    const normalizedMachineId = normalizeId(machineId);
    if (!normalizedMachineId) return [];
    const scopeKey = accountScopeKey(accountScope);
    if (scopeKey === null) return [];
    const set = PUBLISHED_BY_SCOPE.get(publishedSetKey(scopeKey, normalizedMachineId));
    if (!set?.currentness.isCurrent()) return [];
    const diagnostics: ProjectedAgentUiBehaviorDiagnostic[] = [];
    for (const [agentId, published] of [...set.descriptorsByAgentId].sort(([a], [b]) => a.localeCompare(b))) {
        // The publisher stamps the authoring plugin onto every descriptor it
        // projects; an Agent contributed without one is its own author.
        const pluginId = normalizeId(published.descriptor.pluginId) || agentId;
        for (const diagnostic of interpret(agentId, published).diagnostics) {
            diagnostics.push(Object.freeze({ ...diagnostic, agentId, pluginId }));
        }
    }
    return Object.freeze(diagnostics);
}
