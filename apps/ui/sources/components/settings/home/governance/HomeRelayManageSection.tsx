import * as React from 'react';
import { filterRelayAccessProviderDescriptors, parseRelayAccessConfig } from '@happier-dev/cli-common/relayAccess/catalog';
import { accessProviderRefsEqualV1, type AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { MachineHomeRelayTargetV1Schema, MachineReachabilityInspectResultV1Schema } from '@happier-dev/protocol/machines/reachability/actionsV1';
import type { RelayAccessTaskSnapshotV1 } from '@happier-dev/protocol/system/tasks/relayAccessConfigV1';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { buildHomeRelayInspectInput, inspectMachineHomeRelay } from '@/components/machines/security/network/networkActions';
import { useMachineNetworkReview } from '@/components/machines/security/network/useMachineNetworkReview';
import { useScopedActionRun } from '@/components/machines/security/useScopedActionRun';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { useMachineListForServer } from '@/sync/store/hooks';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolvePreferredPublicReleaseRingIdForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

const SECTIONS = ['familiesById.accessProviders', 'familiesById.pluginUi'] as const;
const EMPTY_MACHINES = [] as const;

/** Pick an enrolled Machine in this Account before mounting a Relay Action consumer. */
export function HomeRelayManageSection(props: Readonly<{ serverId: string; disabled: boolean }>) {
    const machines = useMachineListForServer(props.serverId) ?? EMPTY_MACHINES;
    const [machineId, setMachineId] = React.useState<string | null>(null);
    const selected = machines.find(machine => machine.id === machineId) ?? null;
    return <ItemGroup title={t('homeGovernance.reach.relayManage')}>
        <MachineSelector presentation="dropdown" dropdownInCallerSection serverId={props.serverId} machines={machines}
            selectedMachine={selected} dropdownTitle={t('homeGovernance.reach.relayHostingMachine')}
            dropdownSubtitle={t('homeGovernance.reach.relayHostingMachineHelp')} dropdownTestID="home-relay-hosting-machine"
            disableOfflineMachines onSelect={machine => setMachineId(machine.id)} />
        {selected ? <HomeRelayMachineControls key={selected.id} serverId={props.serverId} machineId={selected.id} disabled={props.disabled} /> : null}
    </ItemGroup>;
}

function HomeRelayMachineControls(props: Readonly<{ serverId: string; machineId: string; disabled: boolean }>) {
    const target = React.useMemo(() => ({ serverId: props.serverId, machineId: props.machineId }), [props.serverId, props.machineId]);
    const router = useRouter();
    const openApproval = (approval: ActionApprovalContinuation) => router.push(buildApprovalHref(approval.artifactId, props.serverId) as never);
    const [channel, setChannel] = React.useState(resolvePreferredPublicReleaseRingIdForCurrentApp);
    const [mode, setMode] = React.useState<'user' | 'system'>('user');
    const relay = React.useMemo(() => MachineHomeRelayTargetV1Schema.parse({ channel, mode }), [channel, mode]);
    const [snapshot, setSnapshot] = React.useState<RelayAccessTaskSnapshotV1 | null>(null);
    const [readFailure, setReadFailure] = React.useState<string | null>(null);
    const [readApproval, setReadApproval] = React.useState<ActionApprovalContinuation | null>(null);
    const { run, abort, inFlight, lifetime } = useScopedActionRun(props.serverId);
    const { review, prepare, apply, cancel } = useMachineNetworkReview(target);
    const { inputs } = useDaemonMergedProjectionInputs({ ...target, accountLifetime: lifetime, enabled: !!lifetime, sections: SECTIONS });
    const locale = usePreferredLanguage();
    const allowTailscale = useFeatureEnabled('setup.relayAccess.allowTailscale', { scopeKind: 'spawn', serverId: props.serverId });
    const allowCloudflareTunnel = useFeatureEnabled('setup.relayAccess.allowCloudflareTunnel', { scopeKind: 'spawn', serverId: props.serverId });
    const choices = React.useMemo(() => {
        const localize = createPluginLocalizedTextResolver({ locale, projection: inputs?.pluginUiProjection });
        return [
        ...filterRelayAccessProviderDescriptors({ allowTailscale, allowCloudflareTunnel })
            .filter(entry => entry.definition.targets.includes('homeRelay'))
            .map(entry => ({ id: entry.id, provider: entry.provider, definition: entry.definition,
                title: entry.homeUi ? t(entry.homeUi.titleKey) : entry.title })),
        ...Object.values(inputs?.pluginProjectionV2?.familiesById.accessProviders?.entriesById ?? {})
            .filter(entry => entry.definition.targets.includes('homeRelay') && entry.definition.actions.configure)
            .map(entry => ({ id: entry.id, provider: { pluginId: entry.pluginId, localId: entry.definition.id },
                definition: entry.definition, title: localize(entry.pluginId, entry.definition.title) })),
        ];
    }, [allowCloudflareTunnel, allowTailscale, inputs?.pluginProjectionV2, inputs?.pluginUiProjection, locale]);
    const [choiceId, setChoiceId] = React.useState<string | null>(null);
    const [configuration, setConfiguration] = React.useState('{}');
    const [credentialRefs, setCredentialRefs] = React.useState('[]');
    const [hostname, setHostname] = React.useState('');
    const [invalid, setInvalid] = React.useState(false);
    const choice = choices.find(entry => entry.id === choiceId);
    const current = snapshot?.selection;
    const currentTitle = current ? choices.find(entry => accessProviderRefsEqualV1(entry.provider, current.provider))?.title ?? snapshot?.providerId : undefined;
    const preparing = review.kind === 'preparing' || review.kind === 'applying';
    const busy = props.disabled || !lifetime || preparing;

    const refresh = React.useCallback(async () => {
        if (!lifetime || inFlight()) return;
        setReadFailure(null);
        setReadApproval(null);
        const result = await run('machines.reachability.inspect', buildHomeRelayInspectInput(target, relay),
            (signal, admitted) => inspectMachineHomeRelay(target, relay, { signal, expectedAccountId: admitted.scope.accountId }), setReadApproval);
        if (!result) return;
        setReadApproval(null);
        if (!result.ok) {
            setReadFailure(resolveActionExecutionErrorMessage(result, t('homeGovernance.reach.relayUnavailable')));
            return;
        }
        const parsed = MachineReachabilityInspectResultV1Schema.safeParse(result.result);
        if (parsed.success && parsed.data.relayAccess) setSnapshot(parsed.data.relayAccess);
        else setReadFailure(t('homeGovernance.reach.relayUnavailable'));
    }, [inFlight, lifetime, relay, run, target]);
    React.useEffect(() => {
        setSnapshot(null);
        void refresh();
        return abort;
    }, [abort, refresh]);
    React.useEffect(() => {
        if (review.kind === 'settled' && review.result.relayAccess) setSnapshot(review.result.relayAccess);
    }, [review]);

    const inspectChange = (selection: AccessProviderSelectionV1 | null) => {
        setInvalid(false);
        void prepare({ kind: 'homeRelay', relay, selection, ...(hostname.trim() && selection ? { hostname: hostname.trim() } : {}) });
    };
    const inspectConfiguration = () => {
        if (!choice) return;
        let selection: AccessProviderSelectionV1 | null = null;
        try {
            selection = parseRelayAccessConfig({ provider: choice.provider, config: JSON.parse(configuration),
                credentialRefs: JSON.parse(credentialRefs) }, [choice]);
        } catch { /* Invalid JSON stays in the editor. */ }
        if (selection) inspectChange(selection);
        else setInvalid(true);
    };
    const approval = (review.kind === 'preparing' || review.kind === 'applying') ? review.approval : readApproval;
    const details = snapshot?.status.details;
    const approvalUrl = details && typeof details === 'object' && 'approvalUrl' in details && typeof details.approvalUrl === 'string'
        ? details.approvalUrl : null;

    return <ItemGroup testID="home-relay-selected-controls" surface="none">
        <ValueFieldSelect testID="home-relay-channel" label={t('homeGovernance.reach.relayChannel')} selectedId={channel}
            items={[{ id: 'stable', title: 'Stable' }, { id: 'preview', title: 'Preview' }, { id: 'dev', title: 'Dev' }]}
            onSelect={id => { if (id === 'stable' || id === 'preview' || id === 'dev') { cancel(); setChannel(id); } }} disabled={preparing} />
        <ValueFieldSelect testID="home-relay-mode" label={t('homeGovernance.reach.relayMode')} selectedId={mode}
            items={[{ id: 'user', title: t('homeGovernance.reach.relayModeUser') }, { id: 'system', title: t('homeGovernance.reach.relayModeSystem') }]}
            onSelect={id => { if (id === 'user' || id === 'system') { cancel(); setMode(id); } }} disabled={preparing} />
        {readFailure ? <SurfaceStateCard kind="error" size="line" title={readFailure} action={{ label: t('common.retry'), onPress: refresh }} /> : null}
        {!snapshot && !readFailure && !approval ? <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /> : null}
        {snapshot ? <Item title={currentTitle ?? (snapshot.status.state === 'disabled' ? t('homeGovernance.reach.relayDisabled') : t('homeGovernance.reach.accessMethod'))}
            subtitle={snapshot.status.state !== 'enabled' && (snapshot.configured || snapshot.status.state !== 'disabled')
                ? t(`homeGovernance.reach.relayStatus.${snapshot.status.state}`) : undefined}
            detail={snapshot.status.shareUrl ?? undefined} mode="info" showChevron={false} /> : null}
        {approvalUrl ? <SectionActionButton label={t('homeGovernance.reach.relayAuthorize')}
            onPress={() => { void requestOpenExternalUrl(approvalUrl); }} /> : null}
        {approval ? <ActionApprovalPendingNotice message={t('machineDetailPage.network.approvalWaiting')} onOpenApproval={() => openApproval(approval)} /> : null}
        {snapshot ? <>
            <ValueFieldSelect testID="home-relay-provider" label={t('homeGovernance.reach.accessMethod')} selectedId={choiceId}
                items={current ? choices.filter(entry => accessProviderRefsEqualV1(entry.provider, current.provider)) : choices}
                placeholder={t('homeGovernance.reach.relayChooseProvider')}
                onSelect={id => { cancel(); setChoiceId(id); setInvalid(false);
                    const next = current && choices.find(entry => entry.id === id && accessProviderRefsEqualV1(entry.provider, current.provider));
                    setConfiguration(JSON.stringify(next ? current?.config : {}, null, 2));
                    setCredentialRefs(JSON.stringify(next ? current?.credentialRefs : [], null, 2));
                }} disabled={busy} />
            {choice ? <>
                {Object.keys(choice.definition.configSchema.properties ?? {}).length ? <FieldTextInput
                    accessibilityLabel={t('homeGovernance.reach.relayConfiguration')} placeholder={t('homeGovernance.reach.relayConfiguration')}
                    value={configuration} onChangeText={setConfiguration} autoCapitalize="none" multiline editable={!busy} /> : null}
                {choice.definition.credentialPurposes.length ? <FieldTextInput
                    accessibilityLabel={t('homeGovernance.reach.relayCredentialRefs')} placeholder={t('homeGovernance.reach.relayCredentialRefs')}
                    value={credentialRefs} onChangeText={setCredentialRefs} autoCapitalize="none" multiline editable={!busy} /> : null}
                {!current && choice.definition.https?.hostname !== 'providerAssigned' ? <FieldTextInput
                    accessibilityLabel={t('settings.relayAccess.fields.hostnameLabel')} placeholder={t('settings.relayAccess.fields.hostnameLabel')}
                    value={hostname} onChangeText={setHostname} autoCapitalize="none" editable={!busy} /> : null}
                <SectionActionButton testID="home-relay-review" label={t('homeGovernance.overviewPage.review')} onPress={inspectConfiguration} disabled={busy} />
            </> : null}
            {current ? <SectionActionButton testID="home-relay-disable" label={t('homeGovernance.reach.relayDisable')}
                onPress={() => inspectChange(null)} disabled={busy} /> : null}
        </> : null}
        {invalid ? <SurfaceStateCard kind="error" size="line" title={t('homeGovernance.reach.relayInvalidSelection')} /> : null}
        {review.kind === 'settled' && review.result.status === 'outcome_unknown'
            ? <SurfaceStateCard kind="error" size="line" title={t('homeGovernance.reach.relayStatus.unknown')}
                action={{ label: t('common.retry'), onPress: () => { cancel(); void refresh(); } }} /> : null}
        {review.kind === 'failed' ? <SurfaceStateCard kind="error" size="line" title={resolveActionExecutionErrorMessage(review.failure,
            t('homeGovernance.reach.relayUnavailable'))} /> : null}
        {review.kind === 'review' && review.plan.basis.change.kind === 'homeRelay' ? <>
            <Item title={review.plan.basis.change.selection ? t('homeGovernance.reach.relayConfigure') : t('homeGovernance.reach.relayDisable')}
                detail={review.plan.basis.homeRelay?.route.hostname} mode="info" showChevron={false} />
            <SectionActionButton testID="home-relay-apply" label={t('common.apply')} onPress={apply} disabled={busy} />
            <SectionActionButton label={t('common.cancel')} onPress={cancel} />
        </> : null}
    </ItemGroup>;
}
