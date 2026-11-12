import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DeploymentPrepareInputV1Schema, type DeploymentPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { machineScmStatusSnapshot } from '@/sync/ops/scm/machineScm';
import { t } from '@/text';
import { buildProjectSourceOpenRoute } from '../activation/projectOpenRoute';
import { useNavigateToProjectOpen } from '../activation/projectOpenPresentation';
import { useProjectSource } from '../sources/useProjectSources';
import { createDeploymentActions } from './deploymentActions';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { DeploymentPreparationResult } from './DeploymentPreparationResult';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';

export type DeploymentPreparationContext = Readonly<{
    lifetime: ServerAccountScopeLifetime;
    projectSourceId: string;
    environmentId?: string;
}>;
type PreparationMode = 'prepare' | 'import';

/** What the agent is asked to propose (Plan 60 §3.6 brief goal); the pull request itself is the agent's. */
const PREPARATION_PROPOSAL: readonly Readonly<{ id: string; icon: IconName; title: string | null; detail: 'addsDockerfile' | 'addsCompose' | 'addsHealthDetail' | 'addsVariablesDetail' }>[] = [
    { id: 'dockerfile', icon: 'package', title: 'Dockerfile', detail: 'addsDockerfile' },
    { id: 'compose', icon: 'package', title: 'compose.yaml', detail: 'addsCompose' },
    { id: 'health', icon: 'pulse', title: null, detail: 'addsHealthDetail' },
    { id: 'variables', icon: 'key', title: null, detail: 'addsVariablesDetail' },
];

function PreparationProposal() {
    const { theme } = useUnistyles();
    return <ItemGroup testID="project-deployments.prepare.adds" title={t('projects.deployments.preparation.adds')}>
        {PREPARATION_PROPOSAL.map(row => <Item key={row.id} testID={`project-deployments.prepare.adds.${row.id}`}
            title={row.title ?? t(row.id === 'health' ? 'projects.deployments.preparation.addsHealth' : 'projects.deployments.preparation.addsVariables')}
            subtitle={t(`projects.deployments.preparation.${row.detail}`)} showChevron={false}
            icon={<Icon name={row.icon} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />} />)}
    </ItemGroup>;
}

/** Prepare and Import share the registered Action; neither depends on an investigation record. */
export function DeploymentPreparationEntry(props: DeploymentPreparationContext & Readonly<{ mode: PreparationMode }>) {
    const [handoff, setHandoff] = React.useState<(DeploymentPreparationContext & Readonly<{
        mode: PreparationMode; session: SessionAddress;
    }>) | null>(null);
    // A returned Session belongs to the captured Entry, including while its modal
    // settles after the person has opened another Source or Account.
    const session = handoff && handoff.lifetime === props.lifetime
        && handoff.projectSourceId === props.projectSourceId && handoff.mode === props.mode
        && handoff.environmentId === props.environmentId && props.lifetime.isCurrent()
        ? handoff.session : null;
    const title = t(`projects.deployments.preparation.${props.mode}`);
    return <>
        <SectionActionButton testID={`project-deployments.${props.mode}.open`} title={title} icon="sparkle"
            onPress={() => showDeploymentSheet({ component: DeploymentPreparationSheet,
                props: { ...props, onSessionAvailable: session => setHandoff({ ...props, session }) },
                title, testID: `project-deployments.${props.mode}.dialog`, closeOnBackdrop: false })} />
        {session ? <DeploymentPreparationResult session={session} accountId={props.lifetime.scope.accountId} /> : null}
    </>;
}

function failureCode(error: unknown): string {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable';
}

/** Opened only on the person's gesture: Source and Account rows retain their existing readers. */
function DeploymentPreparationSheet(props: DeploymentPreparationContext & Readonly<{ mode: PreparationMode;
    onSessionAvailable(session: SessionAddress): void }> & CustomModalInjectedProps) {
    const { lifetime, projectSourceId } = props;
    const sourceRead = useProjectSource(lifetime, projectSourceId);
    const source = sourceRead.source?.source ?? null;
    const repository = source?.repository ? readScmHostingRepositoryIdentity({ ...source.repository.provider,
        nameWithOwner: source.repository.repository.nameWithOwner }) : null;
    const [workspaces, setWorkspaces] = React.useState<readonly WorkspaceRefV1[] | null>(null);
    const [readFailure, setReadFailure] = React.useState<string | null>(null);
    const [retry, setRetry] = React.useState(0);
    React.useEffect(() => {
        const cancellation = new AbortController();
        const retired = lifetime.onRetire(() => cancellation.abort());
        void (async () => {
            let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
            try {
                account = await captureLazyActionAccountContext(lifetime.scope.serverId, cancellation.signal);
                if (account.accountId !== lifetime.scope.accountId || !lifetime.isCurrent()) {
                    setReadFailure('action_account_scope_changed'); return;
                }
                const rows = await createUiProjectAccountRowsClient(account).read(cancellation.signal);
                if (!cancellation.signal.aborted) {
                    setWorkspaces(rows.workspaceRefs.filter(ref => areServerProfileIdentifiersEquivalent(ref.serverId, lifetime.scope.serverId)
                        && ref.source?.sourceId === projectSourceId));
                    setReadFailure(null);
                }
            } catch (error) { if (!cancellation.signal.aborted) setReadFailure(failureCode(error)); }
            finally { account?.dispose(); }
        })();
        return () => { cancellation.abort(); retired.dispose(); };
    }, [lifetime, projectSourceId, retry]);
    const [chosenId, setChosenId] = React.useState<string | null>(null);
    const chosen = workspaces?.find(workspace => workspace.id === chosenId)
        ?? (workspaces?.length === 1 ? workspaces[0] : null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [tool, setTool] = React.useState('');
    const [paths, setPaths] = React.useState('');
    const configurationPaths = paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
    const [busy, setBusy] = React.useState(false);
    const [refused, setRefused] = React.useState<string | null>(null);
    const [partial, setPartial] = React.useState<Extract<DeploymentPrepareResultV1, { kind: 'partial' }> | null>(null);
    const router = useRouter();
    const navigateToProjectOpen = useNavigateToProjectOpen();
    const title = t(`projects.deployments.preparation.${props.mode}`);
    const openSession = (session: NonNullable<NonNullable<typeof partial>['sessionRef']>) => {
        props.onSessionAvailable(session); props.onClose(); router.push(buildScopedSessionRouteHref(session));
    };
    const confirm = async () => {
        if (!chosen || !source || !repository || busy) return;
        setBusy(true); setRefused(null); setPartial(null);
        try {
            const status = await machineScmStatusSnapshot(chosen.machineId, { cwd: chosen.rootPath }, lifetime.scope);
            if (!status.success) { setRefused(status.errorCode ?? 'unavailable'); return; }
            const baseCommit = status.snapshot?.branch.headOid;
            if (!baseCommit) { setRefused('base_changed'); return; }
            const input = DeploymentPrepareInputV1Schema.parse({ projectSourceId, sourceRevision: source.revision, repository, baseCommit,
                workspace: { kind: 'workspace-ref', serverId: chosen.serverId, id: chosen.id },
                ...(props.environmentId ? { environmentId: props.environmentId } : {}),
                ...(partial?.sessionRef ? { sessionRef: partial.sessionRef } : {}),
                ...(props.mode === 'import' ? { importFrom: { tool, configurationPaths } } : {}) });
            const result = await createDeploymentActions(lifetime, projectSourceId).prepare(input, chosen.machineId);
            if (result.kind === 'handedOff') openSession(result.sessionRef);
            else if (result.kind === 'partial') {
                if (result.sessionRef) props.onSessionAvailable(result.sessionRef);
                setPartial(result); setRefused(result.reason);
            }
            else setRefused(result.reason);
        } catch (error) { setRefused(failureCode(error)); }
        finally { setBusy(false); }
    };
    const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy,
        testID: 'project-deployments.prepare.cancel' }}>
        <RoundButton testID="project-deployments.prepare.confirm"
            title={props.mode === 'prepare' ? t('projects.deployments.preparation.askAgent') : title} loading={busy}
            disabled={busy || !chosen || !repository || (props.mode === 'import' && (!tool.trim() || configurationPaths.length === 0))}
            onPress={() => { void confirm(); }} />
    </ModalCardFooterActions>;
    const { setChrome } = props;
    React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
    React.useEffect(() => () => setChrome?.(null), [setChrome]);
    return <ListPresentationProvider value="page" pageInsets="contained">
        <View testID="project-deployments.prepare.sheet" style={deploymentSheetStyles.body}>
            <Text style={deploymentSheetStyles.lead}>{t(props.mode === 'import'
                ? 'projects.deployments.preparation.importLead' : 'projects.deployments.preparation.needsSetupLead')}</Text>
            {props.mode === 'prepare' && repository ? <PreparationProposal /> : null}
            {!source && (sourceRead.status === 'initial' || sourceRead.status === 'loading') ?
                <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} /> : !source ?
                <SurfaceStateCard size="line" kind="error" title={t('projects.deployments.unavailableTitle')}
                    reason={deploymentActionRefusalRemedy(sourceRead.issue ?? 'unavailable')} diagnosticCode={sourceRead.issue} /> : !repository ?
                <SurfaceStateCard size="line" kind="empty" title={title} reason={t('projects.deployments.preparation.noRepository')}
                    diagnosticCode={sourceRead.issue} /> : null}
            {readFailure ? <SurfaceStateCard testID="project-deployments.prepare.readFailure" size="line" kind="error"
                title={t('projects.deployments.unavailableTitle')} reason={deploymentActionRefusalRemedy(readFailure)} diagnosticCode={readFailure}
                action={{ label: t('common.retry'), onPress: () => setRetry(value => value + 1) }} />
                : workspaces === null ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
                : workspaces.length === 0 ? <SurfaceStateCard testID="project-deployments.prepare.noWorkspace" size="line" kind="empty"
                    title={t('projects.deployments.preparation.workspace')} reason={t('projects.deployments.preparation.noWorkspace')}
                    {...(source && repository ? { action: { label: t('common.open'), onPress: () => {
                        const route = buildProjectSourceOpenRoute(lifetime.scope.serverId, source);
                        if (route) { props.onClose(); navigateToProjectOpen(route); }
                    } } } : {})} /> :
                <ItemGroup header="none"><DropdownMenu testID="project-deployments.prepare.workspace" open={menuOpen}
                    onOpenChange={setMenuOpen} items={workspaces.map(workspace => ({ id: workspace.id,
                        title: workspace.label ?? workspace.rootPath, subtitle: workspace.rootPath, checked: chosen?.id === workspace.id }))}
                    selectedId={chosen?.id ?? null} onSelect={id => { setChosenId(id); setMenuOpen(false); setRefused(null); setPartial(null); }}
                    itemTrigger={{ title: t('projects.deployments.preparation.workspace'), showSelectedSubtitle: true }} /></ItemGroup>}
            {props.mode === 'import' ? <ItemGroup header="none">
                <Item title={t('projects.deployments.preparation.tool')} accessoryLayout="stacked" rightElement={
                    <FieldTextInput testID="project-deployments.import.tool" value={tool} onChangeText={setTool} editable={!busy}
                        autoCapitalize="none" accessibilityLabel={t('projects.deployments.preparation.tool')} />} />
                <Item title={t('projects.deployments.preparation.paths')} accessoryLayout="stacked" rightElement={
                    <FieldTextInput testID="project-deployments.import.paths" value={paths} onChangeText={setPaths} editable={!busy}
                        multiline minLines={3} monospace autoCapitalize="none" accessibilityLabel={t('projects.deployments.preparation.paths')} />} />
            </ItemGroup> : null}
            {refused ? <SurfaceStateCard testID="project-deployments.prepare.refused" size="line" kind="error" title={t('projects.deployments.unavailableTitle')}
                reason={deploymentActionRefusalRemedy(refused)} diagnosticCode={refused}
                {...(partial?.sessionRef ? { action: { label: t('common.open'), testID: 'project-deployments.prepare.session',
                    onPress: () => { if (partial.sessionRef) openSession(partial.sessionRef); } } } : {})} /> : null}
            {setChrome ? null : footer}
        </View>
    </ListPresentationProvider>;
}
