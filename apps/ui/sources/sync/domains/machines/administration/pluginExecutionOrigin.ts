import { arePluginMachineExecutionOriginsEqual, arePluginMachineExecutionRoutingsEqual, getPluginMachineExecutionRouting, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { resolveFleetSnapshotMachineRejection, resolveFleetSupplyAgreement } from './fleetUnion';
import type { PluginAccountInstalledPluginsAdmission } from '@/sync/domains/plugins/availability/reader';

export type PluginMachineOriginRejectionReasonV1 =
    | 'content_conflict'
    | 'disabled'
    | 'incompatible'
    | 'machine_local'
    | 'missing'
    | 'offline'
    | 'home_unreachable'
    | 'release_unavailable'
    | 'non_portable'
    | 'source_not_ready'
    | 'daemon_unsupported'
    | 'daemon_invalid_response'
    | 'daemon_unavailable'
    | 'activation_refused'
    | 'plugin_mismatch'
    | 'replaced'
    | 'revoked'
    | 'stale'
    | 'untrusted'
    | 'unknown';

export type PluginMachineExecutionOriginCandidateV1 = Readonly<{
    /** Uncollapsed fact supplied by the Artifact owner. */
    materialization: PluginMachineMaterializationV1;
    /** Artifact-owned immutable release-fact comparison result. */
    releaseContent: 'matched' | 'conflict' | 'unknown';
    /** Result of Artifact-owned currentness/release/compatibility validation. */
    validation:
        | Readonly<{ kind: 'admitted' }>
        | Readonly<{ kind: 'rejected'; reason: PluginMachineOriginRejectionReasonV1 }>;
}>;

export type PluginMachineReleaseClassificationV1 = Pick<
    PluginMachineExecutionOriginCandidateV1,
    'releaseContent' | 'validation'
>;

/** Plugin-scoped projection refusals for one exact Machine; these never grant execution authority. */
export type PluginMachineExecutionOriginRejectionV1 = Readonly<{
    serverIdentityId: string;
    machineId: string;
    reason: PluginMachineOriginRejectionReasonV1;
}>;

/** An admitted real projection source, never a synthesized installation row. */
export type PluginMachineSourceExecutionOriginCandidateV1 = PluginMachineReleaseClassificationV1 & Readonly<{
    source: Readonly<{
        origin: Extract<PluginMachineExecutionOriginV1, { sourceRef: unknown }>;
        version: string;
        occurrenceId: string;
        serverId: string;
    }>;
}>;
export type PluginExecutionOriginCandidateV1 = PluginMachineExecutionOriginCandidateV1 | PluginMachineSourceExecutionOriginCandidateV1;

export type PluginExecutionOriginContextualTarget = Readonly<{ serverIdentityId: string; machineId: string }>;

export type PluginExecutionOriginMachineFactReader = (target: PluginExecutionOriginContextualTarget) => Readonly<{
    activeAt: number;
    rejection: ReturnType<typeof resolveFleetSnapshotMachineRejection>;
    eligible: boolean;
}>;

type MachineFactInputs = Readonly<{
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
    readMachineFact?: PluginExecutionOriginMachineFactReader;
}>;

function machineTargetKey(target: PluginExecutionOriginContextualTarget) {
    return `${target.serverIdentityId}\u0000${target.machineId}`;
}

const NO_MATERIALIZATIONS: readonly PluginMachineMaterializationV1[] = Object.freeze([]);

function readMachineFact(params: MachineFactInputs, target: PluginExecutionOriginContextualTarget) {
    if (params.readMachineFact) return params.readMachineFact(target);
    const entry = params.machineSnapshots.find(entry => entry.kind === 'resolved' && entry.serverIdentityId === target.serverIdentityId);
    const snapshot = entry?.kind === 'resolved' ? entry : undefined;
    const machine = snapshot?.machines.find(machine => machine.id === target.machineId);
    return {
        activeAt: machine?.activeAt ?? 0,
        rejection: resolveFleetSnapshotMachineRejection({ snapshot, machine }),
        eligible: snapshot?.executionEligibleMachineIds?.includes(target.machineId) === true,
    };
}

/**
 * A machine-local installation census is not a second executable origin when
 * its real source is present. Keep portable installations and exact source
 * alternatives distinct; the Account Availability inventory stays unmodified.
 */
export function combinePluginMachineExecutionOriginCandidates(
    materializations: readonly PluginMachineExecutionOriginCandidateV1[],
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[],
): readonly PluginExecutionOriginCandidateV1[] {
    return Object.freeze([
        ...materializations.filter(({ materialization }) => materialization.portableRelease || !sources.some(({ source }) => (
            source.origin.serverIdentityId === materialization.serverIdentityId
            && source.origin.sourceRef.machineId === materialization.machineId
            && source.origin.sourceRef.pluginId === materialization.pluginId
        ))),
        ...sources,
    ]);
}

export function getPluginExecutionOriginCandidateOrigin(candidate: PluginExecutionOriginCandidateV1): PluginMachineExecutionOriginV1 {
    return 'source' in candidate ? candidate.source.origin : composePluginMachineExecutionOriginV1(candidate.materialization);
}

export function getPluginExecutionOriginCandidateVersion(candidate: PluginExecutionOriginCandidateV1): string {
    return 'source' in candidate ? candidate.source.version : candidate.materialization.version;
}

/** Only target coordinates determine which Machine facts a plugin consumes. */
export function readPluginExecutionOriginMachineTargets(params: Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
}>): readonly PluginExecutionOriginContextualTarget[] {
    return [
        ...params.materializations.filter((entry) => entry.pluginId === params.pluginId)
            .map(({ serverIdentityId, machineId }) => ({ serverIdentityId, machineId })),
        ...params.sources.filter((entry) => entry.source.origin.sourceRef.pluginId === params.pluginId)
            .map((entry) => ({ serverIdentityId: entry.source.origin.serverIdentityId, machineId: entry.source.origin.sourceRef.machineId })),
    ].sort((left, right) => left.serverIdentityId.localeCompare(right.serverIdentityId) || left.machineId.localeCompare(right.machineId));
}

/** Selection consumes eligibility and activity order, not raw heartbeat timestamps or labels. */
export function serializePluginMachineExecutionOriginMachineFacts(params: MachineFactInputs & Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    targets?: readonly PluginExecutionOriginContextualTarget[];
}>): Readonly<{ eligibilityKey: string; activityKey: string }> {
    const targets = params.targets ?? readPluginExecutionOriginMachineTargets(params);
    return createPluginMachineExecutionOriginMachineFacts({ ...params, targets }).getSnapshot();
}

/** Retained serialization at the existing publication, not an authorization cache. */
export function createPluginMachineExecutionOriginMachineFacts(params: MachineFactInputs & Readonly<{
    targets: readonly PluginExecutionOriginContextualTarget[];
}>) {
    type Row = { target: PluginExecutionOriginContextualTarget; fact: ReturnType<PluginExecutionOriginMachineFactReader>;
        serialized: string; rank: number };
    const compareTarget = (left: Row, right: Row) => left.target.serverIdentityId.localeCompare(right.target.serverIdentityId)
        || left.target.machineId.localeCompare(right.target.machineId);
    const activity = (row: Row) => row.fact.rejection === null ? row.fact.activeAt : 0;
    const compareActivity = (left: Row, right: Row) => activity(right) - activity(left) || compareTarget(left, right);
    const serializeRow = (target: PluginExecutionOriginContextualTarget, fact: Row['fact']) =>
        JSON.stringify([target.serverIdentityId, target.machineId, fact.rejection, fact.eligible]);
    const byHome = new Map<string, Map<string, Row[]>>();
    const rows = params.targets.map(target => {
        const fact = readMachineFact(params, target);
        const row: Row = { target, fact, serialized: serializeRow(target, fact), rank: 0 };
        let home = byHome.get(target.serverIdentityId);
        if (!home) { home = new Map(); byHome.set(target.serverIdentityId, home); }
        const duplicates = home.get(target.machineId);
        if (duplicates) duplicates.push(row); else home.set(target.machineId, [row]);
        return row;
    }).sort(compareTarget);
    const ranked = [...rows].sort(compareActivity);
    ranked.forEach((row, index) => { row.rank = index; });
    const serializeRows = (items: readonly Row[]) => `[${items.map(row => row.serialized).join(',')}]`;
    let current = { eligibilityKey: serializeRows(rows), activityKey: serializeRows(ranked) };
    return {
        getSnapshot: () => current,
        update(inputs: MachineFactInputs, changedTargets: readonly PluginExecutionOriginContextualTarget[] = params.targets) {
            let eligibilityChanged = false;
            let activityChanged = false;
            for (const target of changedTargets) {
                const selected = byHome.get(target.serverIdentityId)?.get(target.machineId);
                if (!selected) continue;
                const fact = readMachineFact(inputs, target);
                for (const row of selected) {
                    if (row.fact.activeAt === fact.activeAt && row.fact.eligible === fact.eligible && row.fact.rejection === fact.rejection) continue;
                    if (row.fact.eligible !== fact.eligible || row.fact.rejection !== fact.rejection) {
                        row.serialized = serializeRow(row.target, fact);
                        eligibilityChanged = true;
                    }
                    row.fact = fact;
                    // Most heartbeats retain order. Only an actual rank change
                    // moves a row; unchanged targets are never read or serialized.
                    const index = row.rank;
                    if ((index > 0 && compareActivity(ranked[index - 1]!, row) > 0)
                        || (index + 1 < ranked.length && compareActivity(row, ranked[index + 1]!) > 0)) {
                        ranked.splice(index, 1);
                        let low = 0;
                        let high = ranked.length;
                        while (low < high) {
                            const middle = (low + high) >>> 1;
                            if (compareActivity(ranked[middle]!, row) <= 0) low = middle + 1;
                            else high = middle;
                        }
                        ranked.splice(low, 0, row);
                        for (let rank = Math.min(index, low); rank <= Math.max(index, low); rank += 1) ranked[rank]!.rank = rank;
                        activityChanged = true;
                    }
                }
            }
            if (eligibilityChanged || activityChanged) {
                const next = { eligibilityKey: eligibilityChanged ? serializeRows(rows) : current.eligibilityKey,
                    activityKey: serializeRows(ranked) };
                if (next.eligibilityKey !== current.eligibilityKey || next.activityKey !== current.activityKey) current = next;
            }
        },
    };
}

export function buildPluginMachineSourceExecutionOriginCandidates(params: MachineFactInputs & Readonly<{
    pluginId: string;
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
}>): readonly PluginMachineSourceExecutionOriginCandidateV1[] {
    return Object.freeze(params.sources.filter((candidate) => candidate.source.origin.sourceRef.pluginId === params.pluginId).map((candidate) => {
        const origin = candidate.source.origin;
        const reason = readMachineFact(params, {
            serverIdentityId: origin.serverIdentityId, machineId: origin.sourceRef.machineId,
        }).rejection;
        return reason ? Object.freeze({ ...candidate, validation: { kind: 'rejected' as const, reason } }) : candidate;
    }));
}

/**
 * Composes the Artifact-owned uncollapsed materialization projection with
 * Administration's exact machine availability. Immutable release/content and
 * compatibility decisions remain injected from the Artifact owner; this
 * function never manufactures those facts from version strings or UI assets.
 */
export function buildPluginMachineExecutionOriginCandidates(params: MachineFactInputs & Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    machineRejections?: readonly PluginMachineExecutionOriginRejectionV1[];
}>): readonly PluginMachineExecutionOriginCandidateV1[] {
    return Object.freeze(params.materializations
        .filter((materialization) => materialization.pluginId === params.pluginId)
        .map((materialization) => {
            const release = params.classifyRelease(materialization);
            return Object.freeze({
                materialization,
                releaseContent: release.releaseContent,
                validation: resolvePluginMachineMaterializationValidation({ materialization, release,
                    machineRejection: readMachineFact(params, materialization).rejection
                        ?? params.machineRejections?.find(entry => entry.serverIdentityId === materialization.serverIdentityId
                            && entry.machineId === materialization.machineId)?.reason ?? null }),
            });
        }).sort(compareCandidates));
}

/** Presentation and fresh invocation share trust/release precedence; machine admission stays fleet-owned. */
export function resolvePluginMachineMaterializationValidation(params: Readonly<{
    materialization: PluginMachineMaterializationV1;
    release: PluginMachineReleaseClassificationV1;
    machineRejection: PluginMachineOriginRejectionReasonV1 | null;
}>): PluginMachineExecutionOriginCandidateV1['validation'] {
    const reason = !params.materialization.enabled ? 'disabled'
        : params.materialization.trustState === 'revoked' ? 'revoked'
            : params.materialization.trustState !== 'trusted' ? 'untrusted' : params.machineRejection;
    return reason ? Object.freeze({ kind: 'rejected', reason }) : params.release.validation;
}

export type PluginMachineExecutionOriginStateV1 =
    | Readonly<{
        kind: 'selected';
        origin: PluginMachineExecutionOriginV1;
        candidate: PluginExecutionOriginCandidateV1;
        selectionSource: 'auto' | 'pinned';
    }>
    | Readonly<{
        kind: 'selectionRequired';
        candidates: readonly PluginExecutionOriginCandidateV1[];
    }>
    | Readonly<{
        kind: 'conflict';
        candidates: readonly PluginExecutionOriginCandidateV1[];
        reasons: readonly ('content_conflict' | 'different_versions' | 'machine_local')[];
    }>
    | Readonly<{
        kind: 'unavailable';
        storedOrigin: PluginMachineExecutionOriginV1 | null;
        storedTarget?: MachineAdministrationTargetV1;
        candidates: readonly PluginExecutionOriginCandidateV1[];
        reasons: readonly (PluginMachineOriginRejectionReasonV1 | 'no_materialization')[];
    }>;

function compareCandidates(
    left: PluginExecutionOriginCandidateV1,
    right: PluginExecutionOriginCandidateV1,
): number {
    const leftOrigin = getPluginExecutionOriginCandidateOrigin(left);
    const rightOrigin = getPluginExecutionOriginCandidateOrigin(right);
    const serverOrder = leftOrigin.serverIdentityId.localeCompare(rightOrigin.serverIdentityId);
    if (serverOrder !== 0) return serverOrder;
    const machineOrder = getPluginMachineExecutionOriginRef(leftOrigin).machineId.localeCompare(getPluginMachineExecutionOriginRef(rightOrigin).machineId);
    return machineOrder !== 0
        ? machineOrder
        : JSON.stringify(leftOrigin).localeCompare(JSON.stringify(rightOrigin));
}

export function composePluginMachineExecutionOriginV1(
    materialization: PluginMachineMaterializationV1,
): Extract<PluginMachineExecutionOriginV1, { materializationRef: unknown }> {
    return Object.freeze({
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: Object.freeze({
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        }),
    });
}

/** Artifact and machine facts that make an exact origin safe to persist/use. */
export function isPluginMachineExecutionOriginCandidateSelectable(
    candidate: PluginExecutionOriginCandidateV1,
): boolean {
    return candidate.validation.kind === 'admitted'
        && candidate.releaseContent === 'matched'
        && ('source' in candidate || candidate.materialization.portableRelease);
}

function candidateMatchesOrigin(
    candidate: PluginExecutionOriginCandidateV1,
    origin: PluginMachineExecutionOriginV1,
): boolean {
    return arePluginMachineExecutionOriginsEqual(getPluginExecutionOriginCandidateOrigin(candidate), origin);
}

function readContributorDeclarations(materializations: readonly PluginMachineMaterializationV1[], installedPlugins?: PluginAccountInstalledPluginsAdmission) {
    return installedPlugins?.kind === 'available'
        ? installedPlugins.plugins.flatMap(plugin => plugin.installations.map(installation => ({
            materialization: installation.materialization, declaration: installation.contributorDeclaration,
        })))
        : materializations.map(materialization => ({ materialization, declaration: materialization.declaredManifest ?? null }));
}

type PluginContributorDeclaration = NonNullable<ReturnType<typeof readContributorDeclarations>[number]['declaration']>;
type PluginMachineScopedContributor = Readonly<{
    materialization: PluginMachineMaterializationV1;
    identity: string;
    nativeSystemTools: readonly string[];
}>;
type PluginDeclarationFacts = Readonly<{
    machineContributions: readonly Readonly<{ id: string; targetPluginId: string }>[];
    nativeSystemTools: readonly string[];
}>;
type PluginContributorFacts = Readonly<{
    knownTargets: ReadonlySet<string>;
    unknownTargets: ReadonlySet<string>;
    contributorsByTargetPlugin: ReadonlyMap<string, readonly PluginMachineScopedContributor[]>;
}>;

// One manifest serves every Machine holding that release.
const declarationFacts = new WeakMap<PluginContributorDeclaration, PluginDeclarationFacts>();

function readDeclarationFacts(declaration: PluginContributorDeclaration): PluginDeclarationFacts {
    let facts = declarationFacts.get(declaration);
    if (facts) return facts;
    const declarations = declaration.contributes;
    const machineActions = new Set(declarations.actions.filter(action => action.execution.target !== 'account').map(action => action.id));
    facts = {
        machineContributions: declarations.targetedPluginContributions
            .filter(contribution => Object.values(contribution.operations).some(id => machineActions.has(id)))
            .map(contribution => ({ id: contribution.id, targetPluginId: contribution.target.pluginId })),
        nativeSystemTools: declarations.connectedAccountDescriptors.flatMap(descriptor =>
            descriptor.authentication.native ? [descriptor.authentication.native.systemTool] : []),
    };
    declarationFacts.set(declaration, facts);
    return facts;
}

// Every plugin demand reads the same Account installations. Availability's
// immutable row list is the only input, so its facts are derived once per list.
const contributorFactsByRows = new WeakMap<object, PluginContributorFacts>();
const NO_CONTRIBUTORS: readonly PluginMachineScopedContributor[] = Object.freeze([]);

function readPluginContributorFacts(materializations: readonly PluginMachineMaterializationV1[],
    installedPlugins?: PluginAccountInstalledPluginsAdmission): PluginContributorFacts {
    const rows = installedPlugins?.kind === 'available' ? installedPlugins.plugins : materializations;
    const previous = contributorFactsByRows.get(rows);
    if (previous) return previous;
    const knownTargets = new Set<string>();
    const unknownTargets = new Set<string>();
    const contributorsByTargetPlugin = new Map<string, PluginMachineScopedContributor[]>();
    for (const { materialization, declaration } of readContributorDeclarations(materializations, installedPlugins)) {
        if (!materialization.enabled || materialization.trustState !== 'trusted') continue;
        (declaration ? knownTargets : unknownTargets).add(machineTargetKey(materialization));
        if (!declaration) continue;
        const { machineContributions, nativeSystemTools } = readDeclarationFacts(declaration);
        for (const contribution of machineContributions) {
            const contributor = { materialization, nativeSystemTools,
                identity: JSON.stringify([materialization.pluginId, contribution.id]) };
            const contributors = contributorsByTargetPlugin.get(contribution.targetPluginId);
            if (contributors) contributors.push(contributor);
            else contributorsByTargetPlugin.set(contribution.targetPluginId, [contributor]);
        }
    }
    const facts = { knownTargets, unknownTargets, contributorsByTargetPlugin };
    contributorFactsByRows.set(rows, facts);
    return facts;
}

/** Installation coverage and native-tool observation consume Availability's resolved declarations. */
export function readPluginMachineScopedContributors(pluginId: string, materializations: readonly PluginMachineMaterializationV1[],
    installedPlugins?: PluginAccountInstalledPluginsAdmission): readonly PluginMachineScopedContributor[] {
    return readPluginContributorFacts(materializations, installedPlugins).contributorsByTargetPlugin.get(pluginId) ?? NO_CONTRIBUTORS;
}

export type PluginExecutionOriginNativeToolAuthentication = PluginExecutionOriginContextualTarget & Readonly<{
    systemTool: string;
    authenticated: boolean;
}>;

/**
 * Administration's sole plugin-origin decision. Artifact admission remains
 * authoritative; local hints rank only admitted, compatible unpinned candidates.
 */
export function resolvePluginMachineExecutionOriginState(params: Readonly<{
    pluginId: string;
    storedOrigin: PluginMachineExecutionOriginV1 | null;
    /** Device-local Machine intent, independent of current source/materialization custody. */
    storedTarget?: MachineAdministrationTargetV1 | null;
    /** The mounted publication's Auto choice; re-admitted below, never a pin. */
    automaticOrigin?: PluginMachineExecutionOriginV1 | null;
    /** Only this Home may supply an automatic, unpinned operation. */
    homeServerIdentityId?: string | null;
    candidates: readonly PluginExecutionOriginCandidateV1[];
    /** Exact supplying origins carrying an admitted installation-default hint. */
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    autoPick?: boolean;
    renderedVersion?: string;
    lastUsedTarget?: MachineAdministrationTargetV1 | null;
    localMachineTarget?: MachineAdministrationTargetV1 | null;
    machineActivity?: readonly (MachineAdministrationTargetV1 & Readonly<{ activeAt: number }>)[];
    /** Existing installation declarations; coverage is a preference, never admission. */
    sourceMaterializations?: readonly PluginMachineMaterializationV1[];
    /** Canonical installation declarations, including thin census rows resolved by Availability. */
    installedPlugins?: PluginAccountInstalledPluginsAdmission;
    /** Already-published native authentication is a preference, never execution authority. */
    nativeToolAuthentication?: readonly PluginExecutionOriginNativeToolAuthentication[];
    /** Incomplete coverage cannot establish absence or incompatibility, but admitted rows may execute. */
    inventoryPending?: boolean;
    /** A Session panel starts at its own machine, not an Account-wide preference. */
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
    /**
     * The stored origin's fleet/projection refusal. When a source stops advertising,
     * preserve its known Home, presence or daemon cause instead of inferring removal.
     */
    storedOriginMachinePresence?: PluginMachineOriginRejectionReasonV1 | null;
}>): PluginMachineExecutionOriginStateV1 {
    if (params.contextualTarget !== undefined) {
        const target = params.contextualTarget;
        return resolvePluginMachineExecutionOriginState({
            ...params,
            contextualTarget: undefined,
            storedOrigin: null,
            storedTarget: null,
            homeServerIdentityId: null,
            candidates: params.candidates.filter((candidate) => {
                const origin = getPluginExecutionOriginCandidateOrigin(candidate);
                return target !== null && origin.serverIdentityId === target.serverIdentityId
                    && getPluginMachineExecutionOriginRef(origin).machineId === target.machineId;
            }),
        });
    }
    const candidates = Object.freeze([...params.candidates]
        .filter((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId === params.pluginId)
        .filter(candidate => params.storedTarget || params.storedOrigin || !params.homeServerIdentityId
            || getPluginExecutionOriginCandidateOrigin(candidate).serverIdentityId === params.homeServerIdentityId)
        .sort(compareCandidates));

    if (params.storedTarget) {
        const target = params.storedTarget;
        const matches = candidates.filter(candidate => {
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            return origin.serverIdentityId === target.serverIdentityId
                && getPluginMachineExecutionOriginRef(origin).machineId === target.machineId;
        });
        if (matches.length === 0) return Object.freeze({ kind: 'unavailable', storedOrigin: null, storedTarget: target,
            candidates, reasons: Object.freeze([params.storedOriginMachinePresence ?? 'missing']) });
        // Narrow placement to the remembered Machine, then reuse the same
        // admission/default decision for its current sources. Custody is not a pin.
        const state = resolvePluginMachineExecutionOriginState({ ...params, storedTarget: null,
            storedOrigin: null, candidates: matches, homeServerIdentityId: null, renderedVersion: undefined });
        return state.kind === 'selected' ? Object.freeze({ ...state, selectionSource: 'pinned' })
            : state.kind === 'unavailable' ? Object.freeze({ ...state, storedTarget: target }) : state;
    }

    if (
        params.storedOrigin !== null
        && getPluginMachineExecutionOriginRef(params.storedOrigin).pluginId !== params.pluginId
    ) {
        return Object.freeze({
            kind: 'unavailable',
            storedOrigin: params.storedOrigin,
            candidates,
            reasons: Object.freeze(['plugin_mismatch'] as const),
        });
    }

    if (params.storedOrigin !== null) {
        const selected = candidates.find((candidate) => candidateMatchesOrigin(candidate, params.storedOrigin!));
        if (!selected) {
            const presence = params.storedOriginMachinePresence;
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze([presence ?? 'missing']),
            });
        }
        if (selected.validation.kind === 'rejected') {
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze([selected.validation.reason]),
            });
        }
        if (selected.releaseContent !== 'matched') {
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze([
                    selected.releaseContent === 'conflict' ? 'content_conflict' : 'unknown',
                ] as const),
            });
        }
        if ('materialization' in selected && !selected.materialization.portableRelease) {
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze(['machine_local'] as const),
            });
        }
        return Object.freeze({
            kind: 'selected',
            origin: params.storedOrigin,
            candidate: selected,
            selectionSource: 'pinned',
        });
    }

    const admitted = candidates.filter((candidate) => candidate.validation.kind === 'admitted');
    const compatible = admitted.filter(candidate => isPluginMachineExecutionOriginCandidateSelectable(candidate)
        && (!params.renderedVersion || getPluginExecutionOriginCandidateVersion(candidate) === params.renderedVersion));
    if (params.inventoryPending && compatible.length === 0) return Object.freeze({ kind: 'unavailable', storedOrigin: null, candidates,
        reasons: Object.freeze(['unknown'] as const) });
    if (admitted.length > 0 && params.renderedVersion && compatible.length === 0) {
        return Object.freeze({ kind: 'conflict', candidates: admitted, reasons: Object.freeze(['different_versions'] as const) });
    }
    const eligible = Object.freeze(params.renderedVersion && compatible.length > 0 ? compatible : admitted);
    if (eligible.length === 0) {
        const reasons = candidates.length === 0
            ? Object.freeze(['no_materialization'] as const)
            : Object.freeze([...new Set(candidates.map((candidate) => (
                candidate.validation.kind === 'rejected' ? candidate.validation.reason : 'unknown'
            )))]);
        return Object.freeze({ kind: 'unavailable', storedOrigin: null, candidates, reasons });
    }
    if (params.autoPick === false && compatible.length > 1) {
        return Object.freeze({ kind: 'selectionRequired', candidates: compatible });
    }
    if (params.autoPick !== false && compatible.length > 0) {
        if (new Set(compatible.map(getPluginExecutionOriginCandidateVersion)).size > 1) {
            return Object.freeze({ kind: 'conflict', candidates: compatible, reasons: Object.freeze(['different_versions'] as const) });
        }
        // Hints only rank alternatives. A sole compatible candidate wins with or without them.
        if (compatible.length === 1) return Object.freeze({ kind: 'selected', origin: getPluginExecutionOriginCandidateOrigin(compatible[0]!),
            candidate: compatible[0]!, selectionSource: 'auto' });
        // Refreshes retain a supplying Machine across replacement custody.
        // Exact saved origins remain pins above.
        const incumbent = params.automaticOrigin && (compatible.find(candidate => candidateMatchesOrigin(candidate, params.automaticOrigin!))
            ?? compatible.find(candidate => arePluginMachineExecutionRoutingsEqual(
                getPluginMachineExecutionRouting(getPluginExecutionOriginCandidateOrigin(candidate)), getPluginMachineExecutionRouting(params.automaticOrigin!))));
        const nativeTools = new Map<string, Set<string>>();
        for (const fact of params.nativeToolAuthentication ?? []) {
            if (!fact.authenticated) continue;
            const key = machineTargetKey(fact);
            const tools = nativeTools.get(key) ?? new Set<string>();
            tools.add(fact.systemTool);
            nativeTools.set(key, tools);
        }
        const contributors = new Map<string, { covered: Set<string>; nativeReady: Set<string> }>();
        const { knownTargets, unknownTargets, contributorsByTargetPlugin } = readPluginContributorFacts(params.sourceMaterializations ?? NO_MATERIALIZATIONS, params.installedPlugins);
        const complete = params.installedPlugins?.kind === 'available' && params.installedPlugins.completeness === 'complete';
        for (const hint of contributorsByTargetPlugin.get(params.pluginId) ?? NO_CONTRIBUTORS) {
            const key = machineTargetKey(hint.materialization);
            const coverage = contributors.get(key) ?? { covered: new Set<string>(), nativeReady: new Set<string>() };
            coverage.covered.add(hint.identity);
            if (hint.nativeSystemTools.some(tool => nativeTools.get(key)?.has(tool))) coverage.nativeReady.add(hint.identity);
            contributors.set(key, coverage);
        }
        const emptyCoverage = { covered: new Set<string>(), nativeReady: new Set<string>() };
        const coverage = (candidate: PluginExecutionOriginCandidateV1) => {
            if (contributors.size === 0) return undefined;
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            const key = machineTargetKey({ serverIdentityId: origin.serverIdentityId, machineId: getPluginMachineExecutionOriginRef(origin).machineId });
            if (params.installedPlugins !== undefined && !complete) return undefined;
            const knownCoverage = contributors.get(key);
            // An unrelated unknown declaration cannot erase observed contributors.
            if (knownCoverage) return knownCoverage;
            if (unknownTargets.has(key) || (!complete && !knownTargets.has(key))) return undefined;
            return emptyCoverage;
        };
        // Replace only with a known strict superset, preserving every observed
        // native-ready contributor. Unknown-zero coverage cannot prove a subset.
        const incumbentCoverage = incumbent ? coverage(incumbent) : undefined;
        const alternatives = incumbent && incumbentCoverage ? compatible.filter(candidate => {
            const next = coverage(candidate);
            if (!next || next.covered.size <= incumbentCoverage.covered.size) return false;
            for (const identity of incumbentCoverage.covered) if (!next.covered.has(identity)) return false;
            for (const identity of incumbentCoverage.nativeReady) if (!next.nativeReady.has(identity)) return false;
            return true;
        }) : compatible;
        if (incumbent && (incumbentCoverage === undefined || alternatives.length === 0)) {
            return Object.freeze({ kind: 'selected', origin: getPluginExecutionOriginCandidateOrigin(incumbent),
                candidate: incumbent, selectionSource: 'auto' });
        }
        const compareCoverage = (left: PluginExecutionOriginCandidateV1, right: PluginExecutionOriginCandidateV1) => {
            const a = coverage(left);
            const b = coverage(right);
            return (b?.nativeReady.size ?? 0) - (a?.nativeReady.size ?? 0)
                || (b?.covered.size ?? 0) - (a?.covered.size ?? 0);
        };
        const matchesTarget = (candidate: PluginExecutionOriginCandidateV1, target: MachineAdministrationTargetV1 | null | undefined) => {
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            return target?.serverIdentityId === origin.serverIdentityId
                && target.machineId === getPluginMachineExecutionOriginRef(origin).machineId;
        };
        const activity = (candidate: PluginExecutionOriginCandidateV1) => params.machineActivity?.find(target => matchesTarget(candidate, target))?.activeAt ?? 0;
        const isDefault = (candidate: PluginExecutionOriginCandidateV1) => params.declaredDefaultOrigins?.some(origin => candidateMatchesOrigin(candidate, origin)) === true;
        const [candidate] = [...alternatives].sort((left, right) =>
            compareCoverage(left, right)
            || Number(matchesTarget(right, params.lastUsedTarget)) - Number(matchesTarget(left, params.lastUsedTarget))
            || Number(matchesTarget(right, params.localMachineTarget)) - Number(matchesTarget(left, params.localMachineTarget))
            || activity(right) - activity(left)
            || Number(isDefault(right)) - Number(isDefault(left))
            || compareCandidates(left, right));
        return Object.freeze({ kind: 'selected', origin: getPluginExecutionOriginCandidateOrigin(candidate!), candidate: candidate!, selectionSource: 'auto' });
    }
    // A default is merely a preference. It can select only an admitted exact
    // origin, and several supplying defaults leave the user's choice open.
    const defaults = eligible.filter((candidate) => isPluginMachineExecutionOriginCandidateSelectable(candidate)
        && params.declaredDefaultOrigins?.some((origin) => candidateMatchesOrigin(candidate, origin)));
    if (defaults.length === 1) {
        const candidate = defaults[0]!;
        return Object.freeze({ kind: 'selected', origin: getPluginExecutionOriginCandidateOrigin(candidate), candidate, selectionSource: 'auto' });
    }
    if (eligible.some((candidate) => candidate.releaseContent === 'unknown')) {
        return Object.freeze({
            kind: 'unavailable',
            storedOrigin: null,
            candidates,
            reasons: Object.freeze(['unknown'] as const),
        });
    }
    const agreement = resolveFleetSupplyAgreement({
        supplies: eligible.map((candidate) => ({ value: candidate, selectable: isPluginMachineExecutionOriginCandidateSelectable(candidate) })),
        identity: () => params.pluginId,
        content: getPluginExecutionOriginCandidateVersion,
    });
    const conflictReasons: ('content_conflict' | 'different_versions' | 'machine_local')[] = [];
    if (agreement.conflictingIdentities.length > 0) conflictReasons.push('different_versions');
    if (eligible.some((candidate) => candidate.releaseContent === 'conflict')) conflictReasons.push('content_conflict');
    if (eligible.some((candidate) => 'materialization' in candidate && !candidate.materialization.portableRelease)) conflictReasons.push('machine_local');
    if (conflictReasons.length > 0) {
        return Object.freeze({
            kind: 'conflict',
            candidates: eligible,
            reasons: Object.freeze(conflictReasons),
        });
    }

    const candidate = eligible[0]!;
    return Object.freeze({ kind: 'selected', origin: getPluginExecutionOriginCandidateOrigin(candidate), candidate, selectionSource: 'auto' });
}
