import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { isDeploymentReadDemandActiveV1, resolveDeploymentCreationDefaultsV1, type DeploymentReadDemandV1 } from '@happier-dev/deployments';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import { isAccountCurrentnessEntityIdV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { readProjectDeploymentDefaults, writeProjectDeploymentDefaults, type ProjectDeploymentDefaultsRead } from '@/sync/api/projects/projectDeploymentDefaults';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { Modal } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';
import { renderDeploymentDefaultsEditorRows } from './DeploymentCreationDefaultsRows';
import { useDeploymentAccountDefaults } from './useDeploymentAccountDefaults';

/** Project overrides use the existing Source leaf and encrypted Artifact Actions. */
export function ProjectDeploymentDefaultsSettings(props: Readonly<{ lifetime: ServerAccountScopeLifetime | null; sourceId: string; demand: DeploymentReadDemandV1;
    /** This page's Environments: triggers belong to each one, so the Project leads to theirs (ORCH-TOP 11-07 15:13). */
    environments?: readonly Readonly<{ id: string; title: string; previewTemplateConfigured?: boolean }>[];
    onOpenEnvironment?: (environmentId: string) => void;
    onOpenPreviews?: (environmentId: string) => void; }>) {
    const { theme } = useUnistyles();
    const { lifetime, sourceId } = props;
    const presented = isDeploymentReadDemandActiveV1(props.demand);
    const execution = useMountedActionExecution(lifetime?.scope);
    const router = useRouter();
    const [value, setValue] = React.useState<ProjectDeploymentDefaultsRead | null>(null);
    const [error, setError] = React.useState<unknown>(null);
    const [retry, setRetry] = React.useState(0);
    const [draft, setDraft] = React.useState<DeploymentCreationDefaultsV1 | null>(null);
    const saving = React.useRef<{ preferences: DeploymentCreationDefaultsV1 } | null>(null);
    React.useEffect(() => {
        if (!lifetime || !presented) return;
        setValue(null);
        setError(null);
        const cancellation = new AbortController();
        const retirement = lifetime.onRetire(() => cancellation.abort());
        const read = async () => {
            try {
                const next = await readProjectDeploymentDefaults(lifetime, sourceId, cancellation.signal);
                if (!cancellation.signal.aborted) { setValue(next); setError(null); }
            } catch (failure) { if (!cancellation.signal.aborted) setError(failure); }
        };
        const stop = subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
            if (event.changeKinds && !event.changeKinds.includes('account')) return;
            if (!event.entityIds || event.entityIds.some(id => isAccountCurrentnessEntityIdV1(id)
                || id === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 || id === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
                || id === `projects:${sourceId}:deploymentDefaults`)) void read();
        }, { serverIds: [lifetime.scope.serverId], reconnect: 'refresh' });
        void read();
        return () => { cancellation.abort(); retirement.dispose(); stop(); };
    }, [lifetime, presented, sourceId, retry]);
    const ownAccount = value?.owner.kind === 'account' && value.owner.accountId === lifetime?.scope.accountId;
    const account = useDeploymentAccountDefaults(ownAccount && presented ? lifetime : null);
    const preferences = draft ?? value?.preferences;
    const resolved = value && preferences ? resolveDeploymentCreationDefaultsV1({
        projectSourceId: sourceId, projectOwner: value.owner,
        projectDefaults: { projectSourceId: sourceId, deploymentDefaults: preferences },
        ...(ownAccount && account.preferences && lifetime ? { account: { accountId: lifetime.scope.accountId, defaults: account.preferences } } : {}),
        target: { kind: 'ownServer', machines: [] },
    }) : null;
    const save = async (edit: React.SetStateAction<DeploymentCreationDefaultsV1>) => {
        if (!lifetime || !value?.canManage || error) return;
        const previous = saving.current?.preferences ?? value.preferences;
        const preferences = typeof edit === 'function' ? edit(previous) : edit;
        if (retainIfEqual(previous, preferences) === previous) return;
        setDraft(preferences);
        if (saving.current) { saving.current.preferences = preferences; return; }
        const pending = { preferences };
        saving.current = pending;
        let confirmed = value;
        try {
            while (true) {
                const sent = pending.preferences;
                confirmed = await writeProjectDeploymentDefaults({ serverId: lifetime.scope.serverId,
                    accountId: lifetime.scope.accountId, current: confirmed, preferences: sent, execute: execution.executeValue });
                if (!lifetime.isCurrent()) break;
                setValue(confirmed);
                if (retainIfEqual(sent, pending.preferences) === sent) break;
            }
        } catch (failure) { Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(failure, t('common.unavailable'))); }
        finally { saving.current = null; setDraft(null); }
    };
    return <ItemList testID="project-deployment-defaults" style={{ paddingTop: 0 }}>
        <PageHeader title={t('projects.deployments.defaultsEditor.projectTitle')}
            description={t('projects.deployments.defaultsEditor.projectDescription')} />
        {execution.approval.approvalPending ? <ActionApprovalPendingNotice message={t('approvals.waitingForYou')}
            summary={execution.approval.approvalSummary} onOpenApproval={execution.approval.openApproval} /> : null}
        {error ? <SurfaceStateCard kind="error" title={t('projects.deployments.loadErrorTitle')}
            action={{ label: t('common.retry'), onPress: () => setRetry(value => value + 1) }} /> : null}
        {value && preferences && resolved && lifetime && (!ownAccount || account.preferences)
            ? renderDeploymentDefaultsEditorRows({ serverId: lifetime.scope.serverId, preferences, resolved,
                inheritLabel: t(ownAccount ? 'projects.deployments.defaultsEditor.useAccount' : 'projects.deployments.defaultsEditor.useBuiltin'),
                resetLabel: t(ownAccount ? 'projects.deployments.defaultsEditor.resetAccount' : 'projects.deployments.defaultsEditor.resetBuiltin'),
                disabled: !value.canManage || !execution.ready || Boolean(error), onChange: next => { void save(next); } })
            : !error ? <SurfaceStateCard kind={account.error ? 'error' : 'loading'} title={t('projects.deployments.creationDefaults')}
            {...(account.error ? { action: { label: t('common.retry'), onPress: account.retry } } : {})} /> : null}
        {ownAccount && lifetime ? <ItemGroup><Item testID="project-deployment-defaults.account" title={t('projects.deployments.defaultsEditor.accountLink')}
            icon={<Icon name="sliders-horizontal" size={18} color={theme.colors.text.secondary} />}
            onPress={() => router.push({ pathname: SETTINGS_ROUTES.deployments, params: { serverId: lifetime.scope.serverId } })} /></ItemGroup> : null}
        {props.environments && props.environments.length > 0 && props.onOpenEnvironment ? <ItemGroup testID="project-deployment-defaults.triggers"
            title={t('projects.deployments.defaultsEditor.triggersTitle')} description={t('projects.deployments.defaultsEditor.triggersDescription')}>
            {props.environments.map(environment => <Item key={environment.id} testID={`project-deployment-defaults.triggers.${environment.id}`}
                title={environment.title} icon={<Icon name="lightning" size={18} color={theme.colors.text.secondary} />}
                onPress={() => props.onOpenEnvironment?.(environment.id)} />)}
        </ItemGroup> : null}
        {props.onOpenPreviews && props.environments?.some(environment => environment.previewTemplateConfigured === true)
          ? <ItemGroup title={t('projects.deployments.sectionPreviews')}>
            {props.environments.filter(environment => environment.previewTemplateConfigured === true).map(environment =>
              <Item key={environment.id} testID={`project-deployment-defaults.previews.${environment.id}`}
                title={environment.title} icon={<Icon name="git-pull-request" size={18} color={theme.colors.text.secondary} />}
                onPress={() => props.onOpenPreviews?.(environment.id)} />)}
          </ItemGroup> : null}
        <ItemGroup><Item testID="deployment-defaults.notifications" title={t('projects.deployments.defaultsEditor.alertChannels')}
            icon={<Icon name="bell" size={18} color={theme.colors.text.secondary} />}
            onPress={() => router.push(SETTINGS_ROUTES.notifications)} /></ItemGroup>
    </ItemList>;
}
