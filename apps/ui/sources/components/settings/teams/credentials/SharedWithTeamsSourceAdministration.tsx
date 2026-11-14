import * as React from 'react';
import type {
    TeamCredentialBrokerPlacementV1,
    TeamCredentialSourceLocatorV1,
    TeamCredentialSourceResourceAdministrationV1,
} from '@happier-dev/protocol/teams';
import { teamCredentialSourceLocatorKeyV1 } from '@happier-dev/protocol/teams';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    deleteTeamCredentialResource,
    listTeamCredentialSourceResources,
    updateTeamCredentialResource,
} from '@/sync/ops/teams/teamCredentialOperations';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    credentialFailureMessage,
    credentialDirectExportFailureMessage,
    resourceStateLabel,
    teamCredentialBrokerPlacementsEqual,
} from './teamCredentialPresentation';
import { TeamCredentialBrokerPlacementSection } from './teamCredentialEditorDraft';
import {
    useOpenedTeamCredentialBrokerPoolNames,
    useOpenedTeamCredentialDisplayNames,
} from './teamCredentialPrivateLabels';

function SourceBrokerPlacementEditor(props: Readonly<{
    scope: ServerAccountScope;
    row: TeamCredentialSourceResourceAdministrationV1;
    displayName: string;
    pending: boolean;
    disabled: boolean;
    onSave: (placement: TeamCredentialBrokerPlacementV1 | null, expectedRevision: number) => Promise<boolean>;
    onCancel: () => void;
}>) {
    const [draft, setDraft] = React.useState<TeamCredentialBrokerPlacementV1 | null>(props.row.brokerPlacement);
    const poolDisplayNames = useOpenedTeamCredentialBrokerPoolNames({
        scope: props.scope,
        brokerPresentation: props.row.brokerPresentation,
    });
    const basisRevision = React.useRef(props.row.revision);
    const latestRevision = React.useRef(props.row.revision);
    latestRevision.current = props.row.revision;
    const changed = !teamCredentialBrokerPlacementsEqual(draft, props.row.brokerPlacement);
    const chooseDraft = (next: TeamCredentialBrokerPlacementV1 | null) => {
        if (!changed) basisRevision.current = props.row.revision;
        setDraft(next);
    };

    React.useEffect(() => {
        if (!changed) setDraft(props.row.brokerPlacement);
    }, [changed, props.row.brokerPlacement, props.row.revision]);

    return (
        <>
            <TeamCredentialBrokerPlacementSection
                scope={props.scope}
                testIDPrefix={`shared-with-teams:broker:${props.row.id}`}
                title={`${t('teams.credentials.detail.brokerLabel')} · ${props.displayName}`}
                brokerPresentation={props.row.brokerPresentation}
                savedPlacement={props.row.brokerPlacement}
                placement={draft}
                poolDisplayNames={poolDisplayNames}
                disabled={props.disabled}
                onChange={chooseDraft}
            />
            {/* The editor's own decision closes it: Cancel and Save as buttons, never a list row. */}
            <ItemGroup surface="none">
                <View style={styles.editorActions}>
                    <RoundButton
                        testID={`shared-with-teams:broker:${props.row.id}:cancel`}
                        size="small"
                        display="secondary"
                        title={t('common.cancel')}
                        disabled={props.pending}
                        onPress={props.onCancel}
                    />
                    <RoundButton
                        testID={`shared-with-teams:broker:${props.row.id}:save`}
                        size="small"
                        title={t('common.save')}
                        disabled={!changed || props.disabled}
                        loading={props.pending}
                        onPress={() => void props.onSave(draft, basisRevision.current).then((saved) => {
                            if (!saved) basisRevision.current = latestRevision.current;
                        })}
                    />
                </View>
            </ItemGroup>
        </>
    );
}

function readSourceResourceNextCursor(page: object): string | null {
    if (!('nextCursor' in page)) return null;
    return typeof page.nextCursor === 'string' ? page.nextCursor : null;
}

export const SharedWithTeamsSourceAdministration = React.memo(function SharedWithTeamsSourceAdministration(
    props: Readonly<{ scope: ServerAccountScope; source: TeamCredentialSourceLocatorV1 }>,
) {
    const router = useRouter();
    const scope = React.useMemo(() => ({
        serverId: props.scope.serverId,
        accountId: props.scope.accountId,
    }), [props.scope.serverId, props.scope.accountId]);
    const sourceKey = teamCredentialSourceLocatorKeyV1(props.source);
    const source = React.useMemo(() => props.source, [sourceKey]);
    const [rows, setRows] = React.useState<readonly TeamCredentialSourceResourceAdministrationV1[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    const [openId, setOpenId] = React.useState<string | null>(null);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [rowsCurrent, setRowsCurrent] = React.useState(false);
    const openedDisplayNames = useOpenedTeamCredentialDisplayNames({
        scope: props.scope,
        resources: rows ?? [],
        enabled: rows !== null,
    });
    // Retained display rows cannot admit a new write while their reload is open.
    // The ref also withdraws admission before React commits the disabled controls.
    const rowsCurrentRef = React.useRef(false);
    const generation = React.useRef(0);
    const readRequest = React.useRef<AbortController | null>(null);
    const actionLifetime = React.useRef<AbortController | null>(null);

    const reload = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        readRequest.current?.abort();
        const controller = new AbortController();
        readRequest.current = controller;
        rowsCurrentRef.current = false;
        setRowsCurrent(false);
        const outcome = await listTeamCredentialSourceResources({ scope, source, signal: controller.signal }).catch(error => {
            if (controller.signal.aborted) return null;
            throw error;
        });
        if (!outcome || generation.current !== requestGeneration) return;
        if (outcome.kind === 'succeeded') {
            setRows(outcome.value.resources);
            setNextCursor(readSourceResourceNextCursor(outcome.value));
            setError(null);
            rowsCurrentRef.current = true;
            setRowsCurrent(true);
        } else {
            setError(credentialFailureMessage(outcome.failure));
        }
    }, [scope, source]);
    const loadMore = React.useCallback(async () => {
        if (!nextCursor || !rowsCurrentRef.current) return;
        const requestGeneration = generation.current;
        const signal = readRequest.current?.signal;
        setLoadingMore(true);
        try {
            const outcome = await listTeamCredentialSourceResources({ scope, source, cursor: nextCursor,
                signal });
            if (generation.current !== requestGeneration) return;
            if (outcome.kind === 'succeeded') {
                setRows((current) => [...(current ?? []), ...outcome.value.resources.filter(
                    (row) => !(current ?? []).some((existing) => existing.id === row.id),
                )]);
                setNextCursor(readSourceResourceNextCursor(outcome.value));
            } else setError(credentialFailureMessage(outcome.failure));
        } catch (error) {
            if (!signal?.aborted) throw error;
        } finally { setLoadingMore(false); }
    }, [nextCursor, scope, source]);
    const approval = useActionApprovalContinuation({
        scopeKey: `${props.scope.serverId}:${props.scope.accountId}:credential-source:${teamCredentialSourceLocatorKeyV1(props.source)}`,
        serverId: props.scope.serverId,
        onExecuted: () => { void reload(); },
    });

    React.useEffect(() => {
        const controller = new AbortController();
        actionLifetime.current = controller;
        setRows(null);
        setError(null);
        setNextCursor(null);
        void reload();
        return () => {
            controller.abort();
            readRequest.current?.abort();
            generation.current += 1;
            rowsCurrentRef.current = false;
        };
    }, [reload]);

    const update = React.useCallback(async (
        row: TeamCredentialSourceResourceAdministrationV1,
        patch: Readonly<{ enabled?: boolean; deliveryPolicy?: { preferredAllowedModes: ['brokered'] }; brokerPlacement?: TeamCredentialBrokerPlacementV1 | null }>,
        expectedRevision = row.revision,
    ): Promise<boolean> => {
        if (!rowsCurrentRef.current) return false;
        const signal = actionLifetime.current?.signal;
        if (!signal || signal.aborted) return false;
        setPendingId(row.id);
        try {
            const outcome = await updateTeamCredentialResource({
                scope: props.scope,
                resourceId: row.id,
                expectedRevision,
                ...patch,
                signal,
            });
            if (signal.aborted) return false;
            if (outcome.kind === 'failed') {
                await reload();
                setError(credentialFailureMessage(outcome.failure));
                return false;
            }
            fireAndForget(reload(), { tag: 'SharedWithTeamsSourceAdministration.revalidate' });
            return true;
        } catch (cause) {
            if (signal.aborted) return false;
            if (isTeamActionApprovalPendingError(cause)) approval.requestApproval(cause.registration);
            await reload();
            if (!isTeamActionApprovalPendingError(cause)) setError(t('teams.errors.generic'));
            return false;
        } finally {
            setPendingId(null);
        }
    }, [approval, props.scope, reload]);
    const remove = React.useCallback(async (row: TeamCredentialSourceResourceAdministrationV1) => {
        if (!rowsCurrentRef.current) return;
        const signal = actionLifetime.current?.signal;
        if (!signal || signal.aborted) return;
        setPendingId(row.id);
        try {
            const outcome = await deleteTeamCredentialResource({ scope: props.scope, resourceId: row.id, expectedRevision: row.revision, signal });
            if (signal.aborted) return;
            if (outcome.kind === 'failed') {
                await reload();
                setError(credentialFailureMessage(outcome.failure));
            } else {
                fireAndForget(reload(), { tag: 'SharedWithTeamsSourceAdministration.revalidate' });
            }
        } catch (cause) {
            if (signal.aborted) return;
            if (isTeamActionApprovalPendingError(cause)) approval.requestApproval(cause.registration);
            await reload();
            if (!isTeamActionApprovalPendingError(cause)) setError(t('teams.errors.generic'));
        } finally {
            setPendingId(null);
        }
    }, [approval, props.scope, reload]);
    const openRow = rows?.find((row) => row.id === openId) ?? null;
    // Nothing shared is the quiet, healthy state: the page's own share action is the way in, so a
    // section that only says "none" (or a loading row for it) is not shown. A share, a failure or a
    // pending approval still speaks.
    if (!approval.approvalId && !error && (rows === null || rows.length === 0)) return null;
    // One explanation: when every share stands the same way, the section says it once and the rows name the Teams.
    const stateLabels = rows?.map((row) => resourceStateLabel(row.readiness)) ?? [];
    const sharedState = stateLabels.length > 1 && stateLabels.every((label) => label === stateLabels[0]) ? stateLabels[0] : null;

    const renderRow = (row: TeamCredentialSourceResourceAdministrationV1) => {
        const busy = !rowsCurrent || pendingId === row.id || approval.approvalPending;
        const displayName = openedDisplayNames[row.id] ?? t('teams.credentials.title');
        // A row's operations live in its ⋯ menu; the row itself names the Team share and its state.
        const actions: ItemAction[] = [
            ...(row.capabilities.updateBrokerPlacement ? [{ id: `shared-with-teams:broker-location:${row.id}`,
                title: t('teams.credentials.sourceAdministration.changeBroker'), icon: 'hard-drives' as const,
                disabled: approval.approvalPending, onPress: () => setOpenId(row.id) }] : []),
            ...(row.capabilities.updateDeliveryPolicy && row.deliveryPolicy.preferredAllowedModes.includes('direct')
                && !row.deliveryPolicy.preferredAllowedModes.includes('vendor-native') ? [{
                id: `shared-with-teams:narrow:${row.id}`, title: t('teams.credentials.edit.ceilingBrokeredOnly'), icon: 'key' as const,
                disabled: busy, onPress: () => { void update(row, { deliveryPolicy: { preferredAllowedModes: ['brokered'] } }); } }] : []),
            ...(row.enabled && row.capabilities.disable ? [{ id: `shared-with-teams:disable:${row.id}`,
                title: t('common.disable'), icon: 'pause-circle' as const, disabled: busy,
                onPress: () => { void update(row, { enabled: false }); } }] : []),
            ...(!row.enabled && row.capabilities.enable ? [{ id: `shared-with-teams:enable:${row.id}`,
                title: t('common.enable'), icon: 'play' as const, disabled: busy,
                onPress: () => { void update(row, { enabled: true }); } }] : []),
            ...(row.capabilities.delete ? [{ id: `shared-with-teams:delete:${row.id}`,
                title: t('teams.credentials.delete.action'), icon: 'trash' as const, destructive: true, disabled: busy,
                onPress: () => { void remove(row); } }] : []),
        ];
        return (
            <Item
                key={row.id}
                testID={`shared-with-teams:resource:${row.id}`}
                title={displayName}
                subtitle={credentialDirectExportFailureMessage(row.directExportFailure) ?? (sharedState === null ? resourceStateLabel(row.readiness) : undefined)}
                showChevron={false}
                rightElement={actions.length > 0 ? (
                    <ItemRowActions title={displayName} actions={actions} overflowOnly
                        overflowTriggerTestID={`shared-with-teams:more:${row.id}`} />
                ) : undefined}
                rightElementOutsidePressable
            />
        );
    };
    // The broker editor opens under the row it edits: the sheet closes after that row, the editor
    // (titled with the credential) follows, and the remaining rows continue on their own sheet.
    const editing = openRow?.capabilities.updateBrokerPlacement ? openRow : null;
    const openIndex = editing && rows ? rows.findIndex((row) => row.id === editing.id) : -1;
    const leadingRows = rows && openIndex >= 0 ? rows.slice(0, openIndex + 1) : rows;
    const trailingRows = rows && openIndex >= 0 ? rows.slice(openIndex + 1) : [];

    return (
        <>
        <ItemGroup title={t('teams.credentials.sourceAdministration.title')} description={error ?? sharedState ?? undefined}>
            {approval.approvalId ? <Item
                testID="shared-with-teams:approval"
                title={t('approvals.title')}
                subtitle={approval.error ? t('approvals.loadError') : t('approvals.status.open')}
                accessibilityLiveRegion={approval.error ? 'assertive' : 'polite'}
                onPress={() => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.scope.serverId)}`)}
                showChevron={false}
            /> : null}
            {leadingRows?.map(renderRow)}
            {trailingRows.length === 0 ? nextCursorAndRetry() : null}
        </ItemGroup>
        {editing ? (
            <SourceBrokerPlacementEditor
                key={editing.id}
                scope={props.scope}
                row={editing}
                displayName={openedDisplayNames[editing.id] ?? t('teams.credentials.title')}
                pending={pendingId === editing.id || approval.approvalPending}
                disabled={!rowsCurrent || pendingId === editing.id || approval.approvalPending}
                onSave={(brokerPlacement, expectedRevision) => update(editing, { brokerPlacement }, expectedRevision)}
                onCancel={() => setOpenId(null)}
            />
        ) : null}
        {trailingRows.length > 0 ? (
            <ItemGroup>
                {trailingRows.map(renderRow)}
                {nextCursorAndRetry()}
            </ItemGroup>
        ) : null}
        </>
    );

    function nextCursorAndRetry() {
        return (
            <>
                {nextCursor ? <Item testID="shared-with-teams:load-more" title={t('common.next')} disabled={!rowsCurrent || loadingMore} loading={loadingMore} onPress={() => void loadMore()} showChevron={false} /> : null}
                {error && rows === null ? (
                    <Item testID="shared-with-teams:retry" title={t('common.retry')} onPress={() => void reload()} showChevron={false} />
                ) : null}
            </>
        );
    }
});

export const SharedWithTeamsForSource = React.memo(function SharedWithTeamsForSource(props: Readonly<{
    serverId: string;
    source: TeamCredentialSourceLocatorV1;
}>) {
    const resolution = useServerCredentialAccountScopeResolution(props.serverId);
    return resolution.kind === 'bound'
        ? <SharedWithTeamsSourceAdministration scope={resolution.scope} source={props.source} />
        : null;
});

const styles = StyleSheet.create((theme) => ({
    editorActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
}));
