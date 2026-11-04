import * as React from 'react';
import type { TeamCredentialBrokerPlacementV1, TeamCredentialDeliveryModeV1, TeamCredentialRouteV1, TeamCredentialRequestPolicyV1, TeamCredentialRequestProtocolKindV1, TeamCredentialResourceReplacementV1, TeamCredentialResourceSummaryV1, TeamCredentialSourceBindingV1, TeamCredentialUsageCapabilitiesV1, TeamCredentialUsageLimitMetricV1, TeamCredentialUsageLimitPeriodV1, TeamCredentialUsageLimitSubjectKindV1, TeamCredentialUsageLimitV1 } from '@happier-dev/protocol/teams';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import {
    buildMachinePoolRowPresentations,
    resolveMachinePoolEnabledMemberLabels,
} from '@/components/machines/pools/machinePoolRowPresentation';
import { Modal } from '@/modal';
import { invalidateMachinePoolProjection } from '@/sync/engine/machines/machinePoolProjection';
import { useMachinePoolProjections } from '@/sync/engine/machines/useMachinePoolProjections';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMachineAdministrationTargetPickerRows } from '@/sync/domains/machines/administration/useTargetSelection';
import { useActiveServerAccountScope, useMachineListByServerId } from '@/sync/store/hooks';
import { t } from '@/text';
import {
    brokerPoolChoiceLabel,
    deliveryModeLabel,
    teamCredentialBrokerPoolAvailabilityLabel,
} from './teamCredentialPresentation';
import {
    buildTeamCredentialBrokerMachineSelection,
    presentTeamCredentialBrokerMachineCandidate,
    resolveTeamCredentialBrokerMachineCandidateAvailability,
} from './teamCredentialBrokerMachineSelection';

export type AudienceDraft = Readonly<{
    allMembers: readonly TeamCredentialRouteV1[] | null;
    groups: ReadonlyMap<string, readonly TeamCredentialRouteV1[]>;
    members: ReadonlyMap<string, readonly TeamCredentialRouteV1[]>;
}>;

export type TeamCredentialPolicyDraft = Readonly<{
    protocols: readonly TeamCredentialRequestProtocolKindV1[] | null;
    allowedModelIds: readonly string[] | null;
    reasoningEffort: TeamCredentialRequestPolicyV1['reasoningEffort'];
}>;

export type TeamCredentialLimitDraft = Readonly<{
    id?: string;
    subjectKind: TeamCredentialUsageLimitSubjectKindV1;
    subjectId: string;
    metric: TeamCredentialUsageLimitMetricV1;
    period: TeamCredentialUsageLimitPeriodV1;
    maximum: string;
    enabled: boolean;
}>;

/**
 * The complete mutable resource form. Presentation, loading and server-current
 * usage-window facts deliberately stay outside this value: they neither save
 * nor make a draft dirty.
 */
export type TeamCredentialResourceDraft = Readonly<{
    name: string;
    source: TeamCredentialSourceBindingV1 | null;
    deliveryPolicy: Readonly<{ preferredAllowedModes: readonly TeamCredentialRouteV1[] }>;
    brokerPlacement: import('@happier-dev/protocol/teams').TeamCredentialBrokerPlacementV1 | null;
    sessionUsePolicy: import('@happier-dev/protocol/teams').TeamCredentialSessionUsePolicyV1;
    audience: AudienceDraft;
    requestPolicy: TeamCredentialPolicyDraft;
    limits: readonly TeamCredentialLimitDraft[];
    pendingLimit: TeamCredentialLimitDraft;
}>;

export const EMPTY_TEAM_CREDENTIAL_POLICY_DRAFT: TeamCredentialPolicyDraft = Object.freeze({
    protocols: null,
    allowedModelIds: null,
    reasoningEffort: null,
});

export const EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT: TeamCredentialResourceDraft = Object.freeze({
    name: '',
    source: null,
    deliveryPolicy: Object.freeze({ preferredAllowedModes: Object.freeze(['brokered'] as const) }),
    brokerPlacement: null,
    sessionUsePolicy: 'personal_allowed',
    audience: Object.freeze({ allMembers: null, groups: new Map(), members: new Map() }),
    requestPolicy: EMPTY_TEAM_CREDENTIAL_POLICY_DRAFT,
    limits: Object.freeze([]),
    pendingLimit: Object.freeze({
        subjectKind: 'resource',
        subjectId: '',
        metric: 'inference_requests',
        period: 'month',
        maximum: '',
        enabled: true,
    }),
});

/**
 * Converts the Home's authorized administration projection into form state.
 * A masked field remains null and must be omitted by the capability-aware
 * update builder; this helper never reconstructs private source identity.
 */
export function teamCredentialResourceDraftFromSummary(
    resource: TeamCredentialResourceSummaryV1,
    limits: readonly TeamCredentialUsageLimitV1[] = [],
): TeamCredentialResourceDraft {
    return {
        name: resource.displayName,
        source: resource.source,
        deliveryPolicy: resource.deliveryPolicy,
        brokerPlacement: resource.brokerPlacement,
        sessionUsePolicy: resource.sessionUsePolicy,
        audience: {
            allMembers: resource.allMembersAllowedRoutes,
            groups: new Map(resource.groupGrants.map((grant) => [grant.teamGroupId, grant.allowedRoutes])),
            members: new Map(resource.memberGrants.map((grant) => [grant.teamMembershipId, grant.allowedRoutes])),
        },
        requestPolicy: teamCredentialPolicyDraftFromPolicy(resource.requestPolicy),
        limits: limits.map((limit) => ({
            id: limit.id,
            subjectKind: limit.subjectKind,
            subjectId: limit.subjectId,
            metric: limit.metric,
            period: limit.period,
            maximum: limit.maximum,
            enabled: limit.enabled,
        })),
        pendingLimit: EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT,
    };
}

function placementKey(placement: TeamCredentialResourceDraft['brokerPlacement']): string {
    if (placement === null) return '';
    return placement.kind === 'machine' ? `machine:${placement.machineId}` : `pool:${placement.poolId}`;
}

function orderedEntries<TValue>(values: ReadonlyMap<string, TValue>): readonly (readonly [string, TValue])[] {
    return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function orderedStrings(values: readonly string[] | null): readonly string[] | null {
    return values === null ? null : [...values].sort((left, right) => left.localeCompare(right));
}

function sourceKey(source: TeamCredentialSourceBindingV1 | null): unknown {
    if (source === null) return null;
    if (source.kind === 'provider_connection') {
        return [source.v, source.kind, source.connectionId, source.connectionSecurityFingerprint, source.credentialSlotId];
    }
    if (source.kind === 'connected_account') {
        return [
            source.v,
            source.kind,
            source.target.account.service.pluginId,
            source.target.account.service.localId,
            source.target.account.accountId,
            source.credentialIncarnation,
        ];
    }
    return [
        source.v,
        source.kind,
        source.target.service.pluginId,
        source.target.service.localId,
        source.target.groupId,
        source.poolIncarnation,
    ];
}

function policyKey(policy: TeamCredentialPolicyDraft): unknown {
    return [
        orderedStrings(policy.protocols),
        orderedStrings(policy.allowedModelIds),
        policy.reasoningEffort === null ? null : [
            orderedStrings(policy.reasoningEffort.allowedValues),
            policy.reasoningEffort.defaultValue,
        ],
    ];
}

function limitKey(limit: TeamCredentialLimitDraft): string {
    return JSON.stringify([
        limit.id ?? null,
        limit.subjectKind,
        limit.subjectId,
        limit.metric,
        limit.period,
        limit.maximum,
        limit.enabled ?? true,
    ]);
}

function audienceKey(audience: AudienceDraft): string {
    return JSON.stringify([
        orderedStrings(audience.allMembers),
        orderedEntries(audience.groups).map(([id, routes]) => [id, orderedStrings(routes)]),
        orderedEntries(audience.members).map(([id, routes]) => [id, orderedStrings(routes)]),
    ]);
}

export function teamCredentialResourceDraftFingerprint(draft: TeamCredentialResourceDraft): string {
    return JSON.stringify([
        draft.name,
        sourceKey(draft.source),
        draft.deliveryPolicy.preferredAllowedModes,
        placementKey(draft.brokerPlacement),
        draft.sessionUsePolicy,
        audienceKey(draft.audience),
        policyKey(draft.requestPolicy),
        [...draft.limits].map(limitKey).sort((left, right) => left.localeCompare(right)),
        limitKey(draft.pendingLimit),
    ]);
}

export function teamCredentialUsageLimitDeltaFromDraft(
    draft: readonly TeamCredentialLimitDraft[],
    baseline: readonly TeamCredentialLimitDraft[],
): TeamCredentialResourceReplacementV1['usageLimitDelta'] | 'invalid' {
    if (draft.some((limit) => !teamCredentialLimitMaximumValid(limit) || !teamCredentialLimitSubjectSelected(limit))) {
        return 'invalid';
    }
    const currentIds = new Set(draft.flatMap((limit) => limit.id ? [limit.id] : []));
    const baselineById = new Map(baseline.flatMap((limit) => limit.id ? [[limit.id, limit] as const] : []));
    return {
        upserts: draft.flatMap((limit) => {
            const normalized = { ...limit, maximum: limit.maximum.trim() };
            const previous = limit.id ? baselineById.get(limit.id) : undefined;
            return previous && limitKey(previous) === limitKey(limit) ? [] : [normalized];
        }),
        deleteIds: baseline.flatMap((limit) => limit.id && !currentIds.has(limit.id) ? [limit.id] : []),
    };
}

function disclosureAudienceEntries(audience: AudienceDraft, route: 'direct' | 'vendor-native'): readonly unknown[] {
    const discloses = (routes: readonly TeamCredentialRouteV1[] | null) => routes?.includes(route) === true;
    return [
        ...(discloses(audience.allMembers) ? [['all_members']] : []),
        ...orderedEntries(audience.groups)
            .filter(([, mode]) => discloses(mode))
            .map(([id]) => ['group', id]),
        ...orderedEntries(audience.members)
            .filter(([, mode]) => discloses(mode))
            .map(([id]) => ['member', id]),
    ];
}

/**
 * Choosing the `brokered_only` ceiling in the create or edit draft.
 *
 * Applies the protocol's one narrowing rule (child 01 §7.1 rule 5) — the same
 * rule the Home applies to a PATCH and to a full replacement: `both` keeps its
 * broker half, a direct-only grant ends, and no grant gains broker use it did
 * not already carry. Broker grants authored afterwards are ordinary edits.
 */
export function narrowTeamCredentialResourceDraftToBrokeredOnly(
    draft: TeamCredentialResourceDraft,
): TeamCredentialResourceDraft {
    const narrow = (routes: readonly TeamCredentialRouteV1[] | null): readonly TeamCredentialRouteV1[] | null =>
        routes?.includes('brokered') ? ['brokered'] : null;
    const narrowGrants = (grants: AudienceDraft['groups']) => new Map(
        [...grants].flatMap(([id, routes]) => {
            const narrowed = narrow(routes);
            return narrowed === null ? [] : [[id, narrowed] as const];
        }),
    );
    return {
        ...draft,
        deliveryPolicy: { preferredAllowedModes: ['brokered'] },
        audience: {
            allMembers: narrow(draft.audience.allMembers),
            groups: narrowGrants(draft.audience.groups),
            members: narrowGrants(draft.audience.members),
        },
    };
}

/** Identity of the exact material-disclosure consequence acknowledged by a user. */
export function teamCredentialDisclosureConsequenceFingerprint(
    targetKey: string,
    draft: TeamCredentialResourceDraft,
): string | null {
    const directAudience = draft.deliveryPolicy.preferredAllowedModes.includes('direct')
        ? disclosureAudienceEntries(draft.audience, 'direct') : [];
    const nativeAllowed = draft.deliveryPolicy.preferredAllowedModes.includes('vendor-native');
    if (draft.source === null || (!nativeAllowed && directAudience.length === 0)) return null;
    return JSON.stringify([
        targetKey,
        sourceKey(draft.source),
        directAudience,
        nativeAllowed ? disclosureAudienceEntries(draft.audience, 'vendor-native') : null,
    ]);
}

/**
 * Canonical route-owned state for the fields shared by create and edit.
 *
 * A target change replaces the entire draft and invalidates any disclosure
 * acknowledgement. Field validation and server/CAS failures do neither: the
 * caller keeps this state until an explicit reset or successful navigation.
 */
export function useTeamCredentialResourceDraft(input: Readonly<{
    targetKey: string;
    initial?: TeamCredentialResourceDraft;
}>) {
    const initial = input.initial ?? EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT;
    const [draft, setDraftState] = React.useState<TeamCredentialResourceDraft>(initial);
    const [baseline, setBaseline] = React.useState<TeamCredentialResourceDraft>(initial);
    const [acceptedDisclosureFingerprint, setAcceptedDisclosureFingerprint] = React.useState<string | null>(null);
    const targetRef = React.useRef(input.targetKey);

    React.useEffect(() => {
        if (targetRef.current === input.targetKey) return;
        targetRef.current = input.targetKey;
        setDraftState(initial);
        setBaseline(initial);
        setAcceptedDisclosureFingerprint(null);
    }, [initial, input.targetKey]);

    const setDraft = React.useCallback((next: React.SetStateAction<TeamCredentialResourceDraft>) => {
        setDraftState(next);
    }, []);
    const updateDisclosureConsequence = React.useCallback((next: React.SetStateAction<TeamCredentialResourceDraft>) => {
        setDraftState(next);
    }, []);
    const reset = React.useCallback((next: TeamCredentialResourceDraft) => {
        setDraftState(next);
        setBaseline(next);
        setAcceptedDisclosureFingerprint(null);
    }, []);
    const disclosureFingerprint = teamCredentialDisclosureConsequenceFingerprint(input.targetKey, draft);
    const baselineDisclosureFingerprint = teamCredentialDisclosureConsequenceFingerprint(input.targetKey, baseline);
    return {
        draft,
        baseline,
        setDraft,
        updateDisclosureConsequence,
        reset,
        isDirty: teamCredentialResourceDraftFingerprint(draft) !== teamCredentialResourceDraftFingerprint(baseline),
        hasAudienceChanges: () => audienceKey(draft.audience) !== audienceKey(baseline.audience),
        disclosureAccepted: disclosureFingerprint === null
            || disclosureFingerprint === baselineDisclosureFingerprint
            || disclosureFingerprint === acceptedDisclosureFingerprint,
        disclosureFingerprint,
        disclosureReviewCompleted: disclosureFingerprint !== null
            && (disclosureFingerprint === baselineDisclosureFingerprint
                || disclosureFingerprint === acceptedDisclosureFingerprint),
        isDisclosureAcceptedForDraft: React.useCallback((next: TeamCredentialResourceDraft) => {
            const fingerprint = teamCredentialDisclosureConsequenceFingerprint(input.targetKey, next);
            return fingerprint === null
                || fingerprint === baselineDisclosureFingerprint
                || fingerprint === acceptedDisclosureFingerprint;
        }, [acceptedDisclosureFingerprint, baselineDisclosureFingerprint, input.targetKey]),
        acceptDisclosure: React.useCallback(() => {
            setAcceptedDisclosureFingerprint(disclosureFingerprint);
        }, [disclosureFingerprint]),
        acceptDisclosureForDraft: React.useCallback((next: TeamCredentialResourceDraft) => {
            setAcceptedDisclosureFingerprint(
                teamCredentialDisclosureConsequenceFingerprint(input.targetKey, next),
            );
        }, [input.targetKey]),
        resetDisclosureConsent: React.useCallback(() => setAcceptedDisclosureFingerprint(null), []),
    } as const;
}

/**
 * The one confirmation shown before a draft starts disclosing material.
 *
 * Create/edit source and audience changes use the same reviewed direct/vendor
 * consequences. Each caller decides whether its draft has already acknowledged
 * this exact consequence, so the question appears once per distinct consequence
 * rather than once per press — and a draft that needs no question is applied
 * without waiting on one.
 */
export async function confirmTeamCredentialDisclosure(draft: TeamCredentialResourceDraft): Promise<boolean> {
    const nativeAllowed = draft.deliveryPolicy.preferredAllowedModes.includes('vendor-native');
    const directAllowed = draft.deliveryPolicy.preferredAllowedModes.includes('direct')
        && disclosureAudienceEntries(draft.audience, 'direct').length > 0;
    return await Modal.confirm(
        nativeAllowed ? t('teams.credentials.nativeDisclosure.title') : t('teams.credentials.audience.directTitle'),
        nativeAllowed ? [t('teams.credentials.nativeDisclosure.body'),
            ...(directAllowed ? [t('teams.credentials.audience.directBody')] : []),
        ].join('\n\n') : t('teams.credentials.audience.directBody'),
        {
            confirmText: nativeAllowed ? t('teams.credentials.nativeDisclosure.confirm') : t('teams.credentials.audience.directConfirm'),
            cancelText: nativeAllowed ? t('common.cancel') : t('teams.credentials.audience.keepBrokered'),
            destructive: true,
        },
    );
}

/**
 * The confirmation a source custodian answers before a resource is allowed to
 * disclose material at all.
 *
 * Widening the ceiling grants nobody anything on its own, but it is the
 * decision that makes every later direct grant possible, so it is asked once
 * here rather than implied by the first grant. Create and edit ask it in the
 * same words.
 */
export async function confirmTeamCredentialDisclosureWidening(): Promise<boolean> {
    return await Modal.confirm(
        t('teams.credentials.audience.directTitle'),
        t('teams.credentials.edit.ceilingNote'),
        { confirmText: t('teams.credentials.edit.ceilingDirectAllowed'), destructive: true },
    );
}

type TeamCredentialBrokerPresentation = TeamCredentialResourceSummaryV1['brokerPresentation'];

const NO_MACHINES: readonly never[] = Object.freeze([]);

/** The draft broker location, named for a review or summary line. */
export function teamCredentialBrokerPlacementDraftLabel(input: Readonly<{
    placement: TeamCredentialBrokerPlacementV1 | null;
    brokerPresentation: TeamCredentialBrokerPresentation;
    pickerRows: Parameters<typeof presentTeamCredentialBrokerMachineCandidate>[0]['pickerRows'];
}>): string {
    const { placement } = input;
    if (placement === null) return t('teams.credentials.detail.brokerNone');
    if (placement.kind === 'machine_pool') {
        const pool = input.brokerPresentation.eligiblePools.find((candidate) => candidate.poolId === placement.poolId)
            ?? input.brokerPresentation.selectedPool;
        return brokerPoolChoiceLabel(pool?.poolId === placement.poolId ? pool : { displayName: null });
    }
    const row = input.pickerRows.find((candidate) => candidate.candidate.target.machineId === placement.machineId);
    return row
        ? presentTeamCredentialBrokerMachineCandidate({
            candidate: row.candidate,
            pickerRows: input.pickerRows,
            unnamedTitle: t('teams.credentials.detail.brokerUnnamedMachine'),
        }).title
        : t('teams.credentials.detail.brokerUnnamedMachine');
}

/**
 * The one "where does this credential broker from" editor.
 *
 * Create, edit and source administration all ask the same question of the same
 * Home projection, so they ask it with the same rows, the same radio semantics,
 * the same availability detail and the same repair behaviour. Eligibility and
 * availability stay the Home's answer; this section only renders it and reports
 * the chosen placement back to whichever draft owns it.
 *
 * A Pool that the live catalog cannot list is still offered as a disabled row
 * when it is the saved or the drafted placement — a configuration nobody can
 * see is a configuration nobody can repair — and a chosen Pool can always be
 * cleared, which the Machine selector's own clear row cannot do.
 */
export const TeamCredentialBrokerPlacementSection = React.memo(function TeamCredentialBrokerPlacementSection(props: Readonly<{
    scope: ServerAccountScope;
    testIDPrefix: string;
    brokerPresentation: TeamCredentialBrokerPresentation;
    /** The placement the Home has stored, which may name a Pool the catalog no longer lists. */
    savedPlacement: TeamCredentialBrokerPlacementV1 | null;
    placement: TeamCredentialBrokerPlacementV1 | null;
    disabled: boolean;
    onChange: (placement: TeamCredentialBrokerPlacementV1 | null) => void;
}>) {
    const { brokerPresentation, disabled, onChange, placement, savedPlacement, scope, testIDPrefix } = props;
    const activeScope = useActiveServerAccountScope();
    const machineLists = useMachineListByServerId();
    const pickerRows = useMachineAdministrationTargetPickerRows();
    const machines = React.useMemo(() => (
        activeScope?.serverId === scope.serverId && activeScope.accountId === scope.accountId
            ? machineLists[scope.serverId] ?? NO_MACHINES
            : NO_MACHINES
    ), [activeScope, machineLists, scope.accountId, scope.serverId]);
    // A resource whose Home offers no Pool for this source has no Pool decision
    // to make, so its custodian's unrelated personal Pool catalog is never
    // hydrated to render an empty group.
    const offersPools = brokerPresentation.eligiblePools.length > 0
        || savedPlacement?.kind === 'machine_pool'
        || placement?.kind === 'machine_pool';
    const poolScopes = React.useMemo(
        () => offersPools ? [{ serverId: scope.serverId, machines }] : [],
        [machines, offersPools, scope.serverId],
    );
    const poolProjection = useMachinePoolProjections(poolScopes)[0];
    const eligiblePoolById = new Map(brokerPresentation.eligiblePools.map((pool) => [pool.poolId, pool]));
    const projectedPools = poolProjection?.accountId === scope.accountId ? poolProjection.pools : [];
    const poolRows = buildMachinePoolRowPresentations(
        projectedPools.filter((candidate) => eligiblePoolById.has(candidate.pool.id)),
        (candidate) => resolveMachinePoolEnabledMemberLabels(candidate, machines).join(', '),
    );
    const draftPoolPlacement = placement?.kind === 'machine_pool' ? placement : null;
    const savedPoolPlacement = savedPlacement?.kind === 'machine_pool' ? savedPlacement : null;
    const livePoolIds = new Set(poolRows.map((row) => row.view.pool.id));
    /**
     * The Pools this group must still offer even though the live catalog cannot.
     *
     * The saved placement earns a repair row so a configuration the catalog lost
     * stays explainable. The unsaved draft earns one for a different reason: a
     * refresh that drops the Pool somebody just picked would otherwise leave the
     * group with no checked choice at all, hiding their own selection from them.
     */
    const unavailablePoolIds = [savedPoolPlacement?.poolId, draftPoolPlacement?.poolId]
        .filter((poolId, index, ids): poolId is string => poolId !== undefined
            && !livePoolIds.has(poolId)
            && ids.indexOf(poolId) === index);
    /** The Home's own safe presentation of a Pool, whichever projection carries it. */
    const homePoolPresentation = (poolId: string) => eligiblePoolById.get(poolId)
        ?? (brokerPresentation.selectedPool?.poolId === poolId ? brokerPresentation.selectedPool : null);
    const poolProjectionPending = poolProjection?.featureStatus === 'loading'
        || (poolProjection?.featureStatus === 'enabled' && poolProjection.status === 'loading');
    const poolProjectionFailed = poolProjection?.featureStatus === 'error'
        || poolProjection?.status === 'error';
    const poolFeatureUnavailable = poolProjection?.featureStatus === 'disabled';
    const poolChoicesVisible = poolRows.length > 0
        || unavailablePoolIds.length > 0
        || poolProjectionPending
        || poolProjectionFailed;
    const machineSelection = buildTeamCredentialBrokerMachineSelection({
        serverId: scope.serverId,
        eligibleTargets: brokerPresentation.eligibleTargets,
        selectedMachineId: placement?.kind === 'machine' ? placement.machineId : null,
        pickerRows,
        onSelectMachineId: (machineId) => onChange({ kind: 'machine', machineId }),
        onClear: () => onChange(null),
    });

    return (
        <>
            <MachineAdministrationTargetSelector
                selection={machineSelection.selection}
                testIDPrefix={testIDPrefix}
                groupTitle={t('teams.credentials.detail.brokerLabel')}
                unselectedTitle={t('teams.credentials.detail.brokerNone')}
                missingTargetTitle={t('teams.credentials.detail.brokerUnnamedMachine')}
                missingTargetSubtitle={null}
                disabled={disabled}
                resolveCandidateAvailability={(candidate) => resolveTeamCredentialBrokerMachineCandidateAvailability({
                    candidate,
                    availabilityByMachineId: machineSelection.availabilityByMachineId,
                    updateRequiredDetail: t('teams.unavailable.updateRequired'),
                    offlineDetail: t('teams.unavailable.offline'),
                    unavailableDetail: t('common.unavailable'),
                    onlineDetail: t('status.online'),
                })}
                resolveCandidatePresentation={(candidate) => presentTeamCredentialBrokerMachineCandidate({
                    candidate,
                    pickerRows: machineSelection.selection.pickerRows,
                    unnamedTitle: t('teams.credentials.detail.brokerUnnamedMachine'),
                })}
            />
            <ItemGroup
                title={t('machinePools.myTitle')}
                description={poolChoicesVisible ? t('machinePools.connectionSemantics') : undefined}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('machinePools.myTitle')}
            >
                {poolChoicesVisible ? (
                    <Item
                        testID={`${testIDPrefix}:machine-pools-caption`}
                        title={<Eyebrow>{t('machinePools.myTitle')}</Eyebrow>}
                        accessibilityLabel={t('machinePools.myTitle')}
                        accessibilityRole="header"
                        webRole="heading"
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {poolProjectionPending || poolProjectionFailed ? (
                    <Item
                        testID={poolProjectionFailed
                            ? `${testIDPrefix}:machine_pool:error`
                            : `${testIDPrefix}:machine_pool:loading`}
                        title={poolProjectionFailed ? t('machinePools.refreshFailed') : t('common.loading')}
                        loading={poolProjectionPending}
                        disabled
                        showChevron={false}
                    />
                ) : null}
                {poolProjectionFailed ? (
                    <Item
                        testID={`${testIDPrefix}:machine_pool:retry`}
                        title={t('common.retry')}
                        accessibilityLabel={`${t('common.retry')}: ${t('machinePools.myTitle')}`}
                        disabled={disabled}
                        onPress={() => {
                            void invalidateMachinePoolProjection(scope.serverId, { forceFeatures: true }).catch(() => {});
                        }}
                        showChevron={false}
                    />
                ) : null}
                {unavailablePoolIds.map((poolId) => {
                    const sourcePresentation = homePoolPresentation(poolId);
                    const title = sourcePresentation?.displayName?.trim()
                        || t('teams.credentials.detail.brokerChosen');
                    const availability = poolFeatureUnavailable
                        ? t('machinePools.featureUnavailable')
                        : sourcePresentation ? teamCredentialBrokerPoolAvailabilityLabel(
                            sourcePresentation.availability,
                            sourcePresentation.availableMachineCount,
                        ) : t('machinePools.notVerified');
                    return (
                        <Item
                            key={poolId}
                            testID={`${testIDPrefix}:machine_pool:${poolId}`}
                            title={title}
                            detail={availability}
                            accessibilityLabel={`${title}. ${availability}. ${poolId}`}
                            accessibilityRole="radio"
                            webRole="radio"
                            selected={draftPoolPlacement?.poolId === poolId}
                            disabled
                            showChevron={false}
                        />
                    );
                })}
                {poolRows.map((row) => {
                    const sourcePresentation = eligiblePoolById.get(row.view.pool.id)!;
                    const availability = teamCredentialBrokerPoolAvailabilityLabel(
                        sourcePresentation.availability,
                        sourcePresentation.availableMachineCount,
                    );
                    const identity = row.identityDetail ? `${row.memberPreview} · ${row.identityDetail}` : row.memberPreview;
                    return (
                        <Item
                            key={row.view.pool.id}
                            testID={`${testIDPrefix}:machine_pool:${row.view.pool.id}`}
                            title={sourcePresentation.displayName?.trim() || row.view.pool.name}
                            subtitle={identity || undefined}
                            detail={availability}
                            accessibilityLabel={`${row.accessibilityName}. ${availability}`}
                            accessibilityRole="radio"
                            webRole="radio"
                            selected={draftPoolPlacement?.poolId === row.view.pool.id}
                            disabled={disabled || poolProjection?.featureStatus !== 'enabled'}
                            onPress={() => onChange({ kind: 'machine_pool', poolId: row.view.pool.id })}
                            showChevron={false}
                        />
                    );
                })}
                {/* The Machine selector's own clear row only appears for a Machine
                    target, so without this a chosen Pool would be a one-way door. */}
                {draftPoolPlacement !== null ? (
                    <Item
                        testID={`${testIDPrefix}:clear`}
                        title={t('settingsPlugins.targetSelection.clear')}
                        disabled={disabled}
                        onPress={() => onChange(null)}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
        </>
    );
});

export function withAudienceEntry(current: AudienceDraft['groups'], id: string, routes: readonly TeamCredentialRouteV1[] | null) { const next = new Map(current); if (routes === null) next.delete(id); else next.set(id, routes); return next; }
export function offeredDeliveryModes(resource: Readonly<{
    deliveryPolicy: TeamCredentialResourceDraft['deliveryPolicy'];
    directExportSupport?: 'supported' | 'mixed' | 'unsupported';
}>): readonly TeamCredentialDeliveryModeV1[] {
    const brokered = resource.deliveryPolicy.preferredAllowedModes.includes('brokered');
    const direct = resource.deliveryPolicy.preferredAllowedModes.includes('direct')
        && resource.directExportSupport !== 'unsupported';
    return brokered && direct ? ['brokered', 'direct', 'both'] : direct ? ['direct'] : brokered ? ['brokered'] : [];
}
/** Presentation adapter for the existing broker/direct controls; `both` never means native. */
export function teamCredentialAudienceRoutesForMode(mode: TeamCredentialDeliveryModeV1, current: readonly TeamCredentialRouteV1[] | null): readonly TeamCredentialRouteV1[] {
    const routes: TeamCredentialRouteV1[] = mode === 'both' ? ['brokered', 'direct'] : [mode];
    const retained = current?.filter(route => route === 'vendor-native' || routes.includes(route)) ?? [];
    return [...retained, ...routes.filter(route => !retained.includes(route))];
}
export const TeamCredentialDeliveryModeChooser = React.memo(function TeamCredentialDeliveryModeChooser(props: Readonly<{ principalKey: string; principalName: string; modes: readonly TeamCredentialDeliveryModeV1[]; current: readonly TeamCredentialRouteV1[] | null; disabled: boolean; onChoose: (routes: readonly TeamCredentialRouteV1[] | null) => void }>) { return <>{props.modes.map(mode => <Item key={mode} testID={`team-credential-audience-mode:${props.principalKey}:${mode}`} title={deliveryModeLabel(mode)} accessibilityLabel={`${props.principalName}, ${deliveryModeLabel(mode)}`} selected={props.current !== null && props.current.includes('brokered') === (mode !== 'direct') && props.current.includes('direct') === (mode !== 'brokered')} disabled={props.disabled} onPress={() => props.onChoose(teamCredentialAudienceRoutesForMode(mode, props.current))} showChevron={false} />)}{props.current === null ? null : <Item testID={`team-credential-audience-mode:${props.principalKey}:remove`} title={t('teams.credentials.audience.remove')} accessibilityLabel={`${props.principalName}, ${t('teams.credentials.audience.remove')}`} destructive disabled={props.disabled} onPress={() => props.onChoose(null)} showChevron={false} />}</>; });

export const TEAM_CREDENTIAL_REQUEST_PROTOCOL_KINDS: readonly TeamCredentialRequestProtocolKindV1[] = ['openai_responses', 'openai_chat_completions', 'anthropic_messages'];
export function teamCredentialRequestProtocolKindFromProviderProtocol(
    protocol: string,
): TeamCredentialRequestProtocolKindV1 | null {
    switch (protocol) {
        case 'openai-responses': return 'openai_responses';
        case 'openai-chat': return 'openai_chat_completions';
        case 'anthropic': return 'anthropic_messages';
        default: return null;
    }
}
export function teamCredentialPolicyDraftFromPolicy(policy: TeamCredentialRequestPolicyV1 | null): TeamCredentialPolicyDraft { return policy === null ? EMPTY_TEAM_CREDENTIAL_POLICY_DRAFT : { protocols: policy.allowedProtocolKinds, allowedModelIds: policy.allowedModelIds, reasoningEffort: policy.reasoningEffort }; }
export function teamCredentialPolicyFromDraft(draft: TeamCredentialPolicyDraft): TeamCredentialRequestPolicyV1 | null { const protocols = draft.protocols?.length ? [...draft.protocols] : null; const models = draft.allowedModelIds?.length ? [...draft.allowedModelIds] : null; if (protocols === null && models === null && draft.reasoningEffort === null) return null; return { allowedProtocolKinds: protocols, allowedModelIds: models, reasoningEffort: draft.reasoningEffort }; }

/**
 * Reconcile only against a positively loaded canonical model catalog.
 * `null` means support is unknown and therefore preserves every field. This is
 * the shared create/edit policy rule: a source transition may propose dropping
 * known-invalid model constraints, but the UI must confirm before committing
 * the returned draft.
 */
export function reconcileTeamCredentialPolicyDraftForModelCatalog(
    draft: TeamCredentialPolicyDraft,
    supportedModelIds: readonly string[] | null,
): Readonly<{ draft: TeamCredentialPolicyDraft; invalidatedModelIds: readonly string[] }> {
    if (supportedModelIds === null || draft.allowedModelIds === null) {
        return { draft, invalidatedModelIds: [] };
    }
    const supported = new Set(supportedModelIds);
    const invalidatedModelIds = draft.allowedModelIds.filter((modelId) => !supported.has(modelId));
    if (invalidatedModelIds.length === 0) return { draft, invalidatedModelIds };
    const allowedModelIds = draft.allowedModelIds.filter((modelId) => supported.has(modelId));
    return {
        draft: { ...draft, allowedModelIds: allowedModelIds.length > 0 ? allowedModelIds : null },
        invalidatedModelIds,
    };
}

export const TEAM_CREDENTIAL_LIMIT_SUBJECT_KINDS: readonly TeamCredentialUsageLimitSubjectKindV1[] = ['resource', 'each_member', 'team_group', 'team_member'];
export function availableTeamCredentialLimitMetrics(capabilities: TeamCredentialUsageCapabilitiesV1 | undefined): readonly TeamCredentialUsageLimitMetricV1[] {
    if (!capabilities || capabilities.limitCoverage === 'unavailable') return [];
    return [
        ...(capabilities.inferenceRequests === 'available' ? ['inference_requests' as const] : []),
        ...(capabilities.totalTokens === 'available' ? ['total_tokens' as const] : []),
        ...(capabilities.costUsd === 'available' ? ['cost_usd' as const] : []),
    ];
}
export const TEAM_CREDENTIAL_LIMIT_PERIODS: readonly TeamCredentialUsageLimitPeriodV1[] = ['day', 'week', 'month'];
export const EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT: TeamCredentialLimitDraft = Object.freeze({ subjectKind: 'resource', subjectId: '', metric: 'inference_requests', period: 'month', maximum: '', enabled: true });
export function teamCredentialLimitMaximumValid(draft: TeamCredentialLimitDraft) { const value = draft.maximum.trim(); return draft.metric === 'cost_usd' ? /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(value) && Number(value) > 0 : /^[1-9]\d*$/u.test(value); }
export function teamCredentialLimitSubjectSelected(draft: TeamCredentialLimitDraft) { return draft.subjectKind === 'resource' || draft.subjectKind === 'each_member' || draft.subjectId.trim() !== ''; }
