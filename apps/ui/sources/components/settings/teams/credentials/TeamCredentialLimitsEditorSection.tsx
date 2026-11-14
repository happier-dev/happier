import * as React from 'react';
import type {
    TeamCredentialResourceSummaryV1,
    TeamCredentialUsageCapabilitiesV1,
} from '@happier-dev/protocol/teams';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamGroupDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import {
    limitMetricLabel,
    limitPeriodLabel,
    limitSubjectKindLabel,
    resourceDirectExposure,
} from './teamCredentialPresentation';
import { TeamCredentialAudiencePicker } from './TeamCredentialAudiencePicker';
import {
    EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT,
    TEAM_CREDENTIAL_LIMIT_PERIODS,
    TEAM_CREDENTIAL_LIMIT_SUBJECT_KINDS,
    availableTeamCredentialLimitMetrics,
    teamCredentialLimitMaximumValid,
    teamCredentialLimitSubjectSelected,
    type TeamCredentialLimitDraft,
    type TeamCredentialResourceDraft,
} from './teamCredentialEditorDraft';

function rowKey(limit: TeamCredentialLimitDraft, index: number): string {
    return limit.id ?? `new-${index}`;
}

export const TeamCredentialLimitsEditorSection = React.memo(function TeamCredentialLimitsEditorSection(props: Readonly<{
    context: TeamSectionContext;
    resource: TeamCredentialResourceSummaryV1 | null;
    usageCapabilities: TeamCredentialUsageCapabilitiesV1 | undefined;
    draft: TeamCredentialResourceDraft;
    busy: boolean;
    onRequestDraftChange: (nextDraft: TeamCredentialResourceDraft) => void;
}>) {
    const { context, resource, usageCapabilities, draft, busy, onRequestDraftChange } = props;
    const [editor, setEditor] = React.useState<Readonly<{ kind: 'add' } | { kind: 'edit'; index: number }> | null>(null);
    const [pickedNames, setPickedNames] = React.useState<ReadonlyMap<string, string>>(() => new Map());
    const [pickedSubjectMembershipId, setPickedSubjectMembershipId] = React.useState<string | null>(null);
    const targetKey = `${context.scope.serverId}:${context.scope.accountId}:${context.address.teamId}:${resource?.id ?? 'new'}`;
    const metrics = availableTeamCredentialLimitMetrics(usageCapabilities);

    React.useEffect(() => {
        setEditor(null);
        setPickedNames(new Map());
        setPickedSubjectMembershipId(null);
    }, [targetKey]);

    const subjects = [...draft.limits, draft.pendingLimit];
    const groups = useTeamGroups({
        scope: context.scope,
        address: context.address,
        archived: 'active',
        enabled: subjects.some((limit) => limit.subjectKind === 'team_group' && limit.subjectId !== ''),
    });
    const members = useTeamMembersRoster({
        scope: context.scope,
        address: context.address,
        filter: 'all',
        enabled: subjects.some((limit) => limit.subjectKind === 'team_member' && limit.subjectId !== ''),
    });
    const groupDisplayNames = useTeamGroupDisplayNames({ scope: context.scope, groups: groups.rows });
    const resolveSubjectName = (limit: TeamCredentialLimitDraft) => {
        const group = limit.subjectKind === 'team_group'
            ? groups.rows.find((row) => row.id === limit.subjectId)
            : undefined;
        const membership = limit.subjectKind === 'team_member'
            ? members.rows.find((row) => row.accountId === limit.subjectId)
            : undefined;
        return (limit.subjectKind === 'team_group'
            ? group === undefined ? null : groupDisplayNames.get(group.id) ?? null
            : membership ? formatAccountDisplayName(membership.account) : null)
            ?? pickedNames.get(`${limit.subjectKind}:${limit.subjectId}`)
            ?? null;
    };
    const subjectLabel = (limit: TeamCredentialLimitDraft) => {
        const name = resolveSubjectName(limit);
        if (name !== null) return name;
        const subjectExists = limit.subjectKind === 'team_group'
            ? groups.rows.some((row) => row.id === limit.subjectId)
            : limit.subjectKind === 'team_member'
                ? members.rows.some((row) => row.accountId === limit.subjectId)
                : false;
        if (subjectExists) return t('teams.credentials.limits.unknownSubject');
        const roster = limit.subjectKind === 'team_group' ? groups : members;
        return roster.status !== 'error' && (roster.status !== 'ready' || roster.hasMore)
            ? t('common.loading')
            : t('teams.credentials.limits.unknownSubject');
    };
    const missingGroups = subjects.some((limit) => limit.subjectKind === 'team_group'
        && limit.subjectId !== ''
        && !groups.rows.some((row) => row.id === limit.subjectId));
    const missingMembers = subjects.some((limit) => limit.subjectKind === 'team_member'
        && limit.subjectId !== ''
        && !members.rows.some((row) => row.accountId === limit.subjectId));
    // Continue the authorized directory only until the saved targets are found.
    // A failed page waits for explicit retry rather than starting a retry loop.
    React.useEffect(() => {
        if (missingGroups && groups.status === 'ready' && groups.hasMore) void groups.loadMore();
    }, [missingGroups, groups.status, groups.hasMore, groups.loadMore, groups.rows]);
    React.useEffect(() => {
        if (missingMembers && members.status === 'ready' && members.hasMore) void members.loadMore();
    }, [missingMembers, members.status, members.hasMore, members.loadMore, members.rows]);

    const requestPendingChange = (pendingLimit: TeamCredentialLimitDraft) => {
        onRequestDraftChange({ ...draft, pendingLimit });
    };
    const closeEditor = () => {
        setEditor(null);
        setPickedSubjectMembershipId(null);
    };
    const exposure = resource === null ? null : resourceDirectExposure(resource);
    const deliveryNote = exposure === 'only'
        ? t('teams.credentials.limits.directOnly')
        : exposure === 'some'
            ? t('teams.credentials.limits.directNote')
            : null;
    // Plan 10.07 §12.5: when some allowed route cannot observe tokens, the
    // projection offers request limits instead and says which routes.
    const routeNote = usageCapabilities?.inferenceRequests === 'available'
        && usageCapabilities.totalTokens !== 'available'
        ? t('teams.credentials.limits.requestLimitsOnlyForPersonalUse')
        : null;

    return (
        <>
            <ItemGroup
                title={t('teams.credentials.limits.title')}
                description={[t('teams.credentials.limits.overshoot'), deliveryNote, routeNote]
                    .filter((part): part is string => part !== null)
                    .join('\n')}
            >
                {draft.limits.length === 0 ? (
                    <Item
                        testID="team-credential-limits-empty"
                        title={t('teams.credentials.limits.empty')}
                        showChevron={false}
                    />
                ) : draft.limits.map((limit, index) => {
                    const key = rowKey(limit, index);
                    return (
                        <React.Fragment key={key}>
                            <Item
                                testID={`team-credential-limit-edit:${key}`}
                                title={limit.subjectKind === 'team_member' || limit.subjectKind === 'team_group'
                                    ? `${limitSubjectKindLabel(limit.subjectKind)} · ${subjectLabel(limit)}`
                                    : limitSubjectKindLabel(limit.subjectKind)}
                                subtitle={`${limitMetricLabel(limit.metric)} · ${limitPeriodLabel(limit.period)} · ${limit.maximum}`}
                                detail={!limit.enabled ? t('teams.credentials.limits.disabled') : undefined}
                                disabled={busy}
                                onPress={() => {
                                    requestPendingChange(limit);
                                    setPickedSubjectMembershipId(null);
                                    setEditor({ kind: 'edit', index });
                                }}
                                showChevron={false}
                            />
                            <Item
                                testID={`team-credential-limit-remove:${key}`}
                                title={t('teams.credentials.limits.remove')}
                                destructive
                                disabled={busy}
                                onPress={() => {
                                    const limits = draft.limits.filter((_, candidateIndex) => candidateIndex !== index);
                                    const closesCurrent = editor?.kind === 'edit' && editor.index === index;
                                    onRequestDraftChange({
                                        ...draft,
                                        limits,
                                        ...(closesCurrent ? { pendingLimit: EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT } : {}),
                                    });
                                    if (closesCurrent) closeEditor();
                                }}
                                showChevron={false}
                            />
                        </React.Fragment>
                    );
                })}
                {missingGroups && groups.error ? <Item testID="team-credential-limit-groups-retry"
                    title={t('common.retry')} subtitle={t('teams.credentials.limits.subject.group')}
                    onPress={() => { void groups.reload(); }} showChevron={false} /> : null}
                {missingMembers && members.error ? <Item testID="team-credential-limit-members-retry"
                    title={t('common.retry')} subtitle={t('teams.credentials.limits.subject.member')}
                    onPress={() => { void members.reload(); }} showChevron={false} /> : null}
            </ItemGroup>

            {editor === null ? (
                <ItemGroup>
                    <Item
                        testID="team-credential-limit-add"
                        title={t('teams.credentials.limits.add')}
                        disabled={busy || metrics.length === 0}
                        onPress={() => {
                            requestPendingChange(EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT);
                            setPickedSubjectMembershipId(null);
                            setEditor({ kind: 'add' });
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : (
                <>
                    <ItemGroup
                        title={t('teams.credentials.limits.subjectLabel')}
                        accessibilityRole="radiogroup"
                        accessibilityLabel={t('teams.credentials.limits.subjectLabel')}
                    >
                        {TEAM_CREDENTIAL_LIMIT_SUBJECT_KINDS.map((kind) => (
                            <Item
                                key={kind}
                                testID={`team-credential-limit-subject:${kind}`}
                                title={limitSubjectKindLabel(kind)}
                                selected={draft.pendingLimit.subjectKind === kind}
                                disabled={busy}
                                onPress={() => {
                                    setPickedSubjectMembershipId(null);
                                    requestPendingChange({ ...draft.pendingLimit, subjectKind: kind, subjectId: '' });
                                }}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>

                    {draft.pendingLimit.subjectKind === 'team_group' ? (
                        <ItemGroup title={t('teams.credentials.limits.subject.group')}>
                            {draft.pendingLimit.subjectId ? (
                                <Item
                                    testID={`team-credential-limit-group:${draft.pendingLimit.subjectId}`}
                                    title={subjectLabel(draft.pendingLimit)}
                                    selected
                                    showChevron={false}
                                />
                            ) : null}
                            <TeamCredentialAudiencePicker
                                testID="team-credential-limit-group-choose"
                                scope={context.scope}
                                address={context.address}
                                excludedGroupIds={draft.pendingLimit.subjectId ? [draft.pendingLimit.subjectId] : []}
                                excludedMemberIds={[]}
                                allowedKinds={['group']}
                                label={t('teams.credentials.limits.subject.group')}
                                disabled={busy}
                                onChoose={(principal) => {
                                    if (principal.kind !== 'group') return;
                                    setPickedNames((names) => new Map(names).set(`team_group:${principal.id}`, principal.name));
                                    requestPendingChange({ ...draft.pendingLimit, subjectId: principal.id });
                                }}
                            />
                        </ItemGroup>
                    ) : null}

                    {draft.pendingLimit.subjectKind === 'team_member' ? (
                        <ItemGroup title={t('teams.credentials.limits.subject.member')}>
                            {draft.pendingLimit.subjectId ? (
                                <Item
                                    testID={`team-credential-limit-member-account:${draft.pendingLimit.subjectId}`}
                                    title={subjectLabel(draft.pendingLimit)}
                                    selected
                                    showChevron={false}
                                />
                            ) : null}
                            <TeamCredentialAudiencePicker
                                testID="team-credential-limit-member-choose"
                                scope={context.scope}
                                address={context.address}
                                excludedGroupIds={[]}
                                excludedMemberIds={pickedSubjectMembershipId ? [pickedSubjectMembershipId] : []}
                                allowedKinds={['member']}
                                label={t('teams.credentials.limits.subject.member')}
                                disabled={busy}
                                onChoose={(principal) => {
                                    if (principal.kind !== 'member') return;
                                    setPickedNames((names) => new Map(names).set(`team_member:${principal.accountId}`, principal.name));
                                    setPickedSubjectMembershipId(principal.id);
                                    requestPendingChange({ ...draft.pendingLimit, subjectId: principal.accountId });
                                }}
                            />
                        </ItemGroup>
                    ) : null}

                    <ItemGroup
                        title={t('teams.credentials.limits.metricLabel')}
                        description={draft.pendingLimit.metric === 'cost_usd'
                            ? t('teams.credentials.limits.costNote')
                            : undefined}
                        accessibilityRole="radiogroup"
                        accessibilityLabel={t('teams.credentials.limits.metricLabel')}
                    >
                        {metrics.map((metric) => (
                            <Item
                                key={metric}
                                testID={`team-credential-limit-metric:${metric}`}
                                title={limitMetricLabel(metric)}
                                selected={draft.pendingLimit.metric === metric}
                                disabled={busy}
                                onPress={() => requestPendingChange({ ...draft.pendingLimit, metric })}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>

                    <ItemGroup
                        title={t('teams.credentials.limits.periodLabel')}
                        accessibilityRole="radiogroup"
                        accessibilityLabel={t('teams.credentials.limits.periodLabel')}
                    >
                        {TEAM_CREDENTIAL_LIMIT_PERIODS.map((period) => (
                            <Item
                                key={period}
                                testID={`team-credential-limit-period:${period}`}
                                title={limitPeriodLabel(period)}
                                selected={draft.pendingLimit.period === period}
                                disabled={busy}
                                onPress={() => requestPendingChange({ ...draft.pendingLimit, period })}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>

                    <ItemGroup
                        title={t('teams.credentials.limits.maximumLabel')}
                        description={draft.pendingLimit.maximum.trim() !== '' && !teamCredentialLimitMaximumValid(draft.pendingLimit)
                            ? (draft.pendingLimit.metric === 'cost_usd'
                                ? t('teams.credentials.limits.maximumInvalidCost')
                                : t('teams.credentials.limits.maximumInvalid'))
                            : t('teams.credentials.limits.overshoot')}
                    >
                        <Item title={t('teams.credentials.limits.maximumLabel')} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="team-credential-limit-maximum" value={draft.pendingLimit.maximum} onChangeText={(maximum) => requestPendingChange({ ...draft.pendingLimit, maximum })} placeholder={t('teams.credentials.limits.maximumPlaceholder')} accessibilityLabel={t('teams.credentials.limits.maximumLabel')} keyboardType="numeric" editable={!busy} />} />
                    </ItemGroup>

                    <ItemGroup>
                        <Item
                            testID="team-credential-limit-save"
                            title={editor.kind === 'add'
                                ? t('teams.credentials.limits.add')
                                : t('common.save')}
                            disabled={busy
                                || !metrics.includes(draft.pendingLimit.metric)
                                || !teamCredentialLimitMaximumValid(draft.pendingLimit)
                                || !teamCredentialLimitSubjectSelected(draft.pendingLimit)}
                            onPress={() => {
                                if (busy
                                    || !metrics.includes(draft.pendingLimit.metric)
                                    || !teamCredentialLimitMaximumValid(draft.pendingLimit)
                                    || !teamCredentialLimitSubjectSelected(draft.pendingLimit)) return;
                                const nextLimit = {
                                    ...draft.pendingLimit,
                                    subjectId: draft.pendingLimit.subjectKind === 'team_group'
                                        || draft.pendingLimit.subjectKind === 'team_member'
                                        ? draft.pendingLimit.subjectId
                                        : '',
                                };
                                const limits = editor.kind === 'add'
                                    ? [...draft.limits, nextLimit]
                                    : draft.limits.map((limit, index) => index === editor.index ? nextLimit : limit);
                                onRequestDraftChange({
                                    ...draft,
                                    limits,
                                    pendingLimit: EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT,
                                });
                                closeEditor();
                            }}
                            showChevron={false}
                        />
                        <Item
                            testID="team-credential-limit-cancel"
                            title={t('common.cancel')}
                            disabled={busy}
                            onPress={() => {
                                onRequestDraftChange({ ...draft, pendingLimit: EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT });
                                closeEditor();
                            }}
                            showChevron={false}
                        />
                    </ItemGroup>
                </>
            )}
        </>
    );
});
