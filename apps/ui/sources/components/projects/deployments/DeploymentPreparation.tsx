import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DeploymentPrepareInputV1Schema, type DeploymentPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { readProjectSourceRepositoryIdentityV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectActionExecuteFailure, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Button } from '@happier-dev/plugin-ui/components';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
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
import { composeSessionServerStartDraft } from '@/components/sessions/new/serverStartDraftComposer';
import { presentSessionServerStartDraftComposer } from '@/components/sessions/new/serverStartDraftComposerPresentation';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { machineScmStatusSnapshot } from '@/sync/ops/scm/machineScm';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { buildProjectSourceOpenRoute } from '../activation/projectOpenRoute.mjs';
import { useNavigateToProjectOpen } from '../activation/projectOpenPresentation';
import { useProjectSource } from '../sources/useProjectSources';
import { createDeploymentActions } from './deploymentActions';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { DeploymentPreparationResult } from './DeploymentPreparationResult';
import { DeploymentPreparationRecognized, type RecognizedRepositoryRead } from './DeploymentPreparationRecognized';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { readDeploymentPreparationFacts } from './deploymentPreflightWarnings';

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

/** Lab f1prep: what the checkout's own files declare (projects.inspect), read once per chosen checkout. Never a guess. */
function useRecognizedApplications(lifetime: ServerAccountScopeLifetime, workspace: WorkspaceRefV1 | null, enabled: boolean) {
    const [read, setRead] = React.useState<(RecognizedRepositoryRead & Readonly<{ workspaceId: string }>) | null>(null);
    const [retry, setRetry] = React.useState(0);
    const workspaceId = enabled ? workspace?.id ?? null : null;
    React.useEffect(() => {
        if (!workspace || !workspaceId) return;
        const cancellation = new AbortController();
        setRead(previous => previous?.workspaceId === workspaceId && previous.status === 'ready' ? previous : { status: 'loading', workspaceId });
        readDeploymentPreparationFacts(lifetime, { configure: { name: '' }, workspace: { serverId: workspace.serverId, workspaceId,
            machineId: workspace.machineId, rootPath: workspace.rootPath } }, { signal: cancellation.signal })
            .then(result => {
                if (cancellation.signal.aborted) return;
                setRead(!result.ok ? { status: 'failed', code: result.errorCode, workspaceId }
                    : result.repository.status === 'notInspected' ? { status: 'failed', code: 'unavailable', workspaceId }
                    : { status: 'ready', workspaceId, facts: { applications: result.repository.applications,
                        partial: result.repository.coverage === 'partial', rootFiles: result.repository.rootFiles,
                        environmentExample: result.repository.environmentExample, healthPath: result.repository.healthPath } });
            })
            .catch((error: unknown) => { if (!cancellation.signal.aborted) setRead({ status: 'failed', code: failureCode(error), workspaceId }); });
        return () => cancellation.abort();
    }, [lifetime, workspace, workspaceId, retry]);
    return { read: read?.workspaceId === workspaceId ? read : null, retry: () => setRetry(value => value + 1) };
}

/** Prepare and Import share the registered Action; neither depends on an investigation record. */
export function DeploymentPreparationEntry(props: DeploymentPreparationContext & Readonly<{
    mode: PreparationMode;
    /**
     * Set where the entry stands among agent-action controls (an Environment's Ask an agent): it takes their face, at
     * this emphasis, so the row reads as one set of buttons (PAGE-ACCEPT-176 R3-D1). Absent, it is a section action.
     */
    emphasis?: 'primary' | 'secondary' | 'plain';
}>) {
    const [handoff, setHandoff] = React.useState<(DeploymentPreparationContext & Readonly<{
        mode: PreparationMode; session: SessionAddress; recognized: RecognizedRepositoryRead | null;
    }>) | null>(null);
    // A returned Session belongs to the captured Entry, including while its modal
    // settles after the person has opened another Source or Account.
    const currentHandoff = handoff && handoff.lifetime === props.lifetime
        && handoff.projectSourceId === props.projectSourceId && handoff.mode === props.mode
        && handoff.environmentId === props.environmentId && props.lifetime.isCurrent()
        ? handoff : null;
    const title = t(`projects.deployments.preparation.${props.mode}`);
    const { emphasis, ...context } = props;
    const open = () => showDeploymentSheet({ component: DeploymentPreparationSheet,
        props: { ...context, onSessionAvailable: (session, recognized) => setHandoff({ ...context, session, recognized }) },
        title, testID: `project-deployments.${props.mode}.dialog`, closeOnBackdrop: false });
    return <>
        {emphasis ? (
            <CorePluginUiPresentationScope>
                <Button testID={`project-deployments.${props.mode}.open`} title={title} variant={emphasis} size="small" onPress={open} />
            </CorePluginUiPresentationScope>
        ) : <SectionActionButton testID={`project-deployments.${props.mode}.open`} title={title} icon="sparkle" onPress={open} />}
        {currentHandoff ? <DeploymentPreparationResult session={currentHandoff.session} lifetime={props.lifetime}
            recognized={currentHandoff.recognized} /> : null}
    </>;
}

function failureCode(error: unknown): string {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable';
}

/** Opened only on the person's gesture: Source and Account rows retain their existing readers. */
function DeploymentPreparationSheet(props: DeploymentPreparationContext & Readonly<{ mode: PreparationMode;
    onSessionAvailable(session: SessionAddress, recognized: RecognizedRepositoryRead | null): void }> & CustomModalInjectedProps) {
    const { lifetime, projectSourceId } = props;
    const sourceRead = useProjectSource(lifetime, projectSourceId);
    const source = sourceRead.source?.source ?? null;
    const repository = readProjectSourceRepositoryIdentityV1(source?.repository);
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
    const recognized = useRecognizedApplications(lifetime, chosen ?? null, props.mode === 'prepare');
    const [tool, setTool] = React.useState('');
    const [paths, setPaths] = React.useState('');
    const configurationPaths = paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
    const [busy, setBusy] = React.useState(false);
    const [refused, setRefused] = React.useState<ActionExecuteFailure | null>(null);
    const refusal = refused ? resolveActionExecutionFailureMessage(refused, deploymentActionRefusalRemedy(refused.errorCode)) : null;
    const [partial, setPartial] = React.useState<Extract<DeploymentPrepareResultV1, { kind: 'partial' }> | null>(null);
    const authoring = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => authoring.current?.abort(), []);
    const router = useRouter();
    const navigateToProjectOpen = useNavigateToProjectOpen();
    const title = t(`projects.deployments.preparation.${props.mode}`);
    const readAtHandoff = recognized.read?.status === 'ready' ? recognized.read : null;
    const openSession = (session: NonNullable<NonNullable<typeof partial>['sessionRef']>) => {
        props.onSessionAvailable(session, readAtHandoff); props.onClose(); router.push(buildScopedSessionRouteHref(session));
    };
    const confirm = async () => {
        if (!chosen || !source || !repository || busy) return;
        setBusy(true); setRefused(null); setPartial(null);
        const cancellation = new AbortController();
        authoring.current = cancellation;
        const retired = lifetime.onRetire(() => cancellation.abort());
        try {
            const recipe = partial?.sessionRef ? null : await composeSessionServerStartDraft({
                draft: { directory: chosen.rootPath },
                target: { serverId: chosen.serverId, machineId: chosen.machineId },
                signal: cancellation.signal, isCurrent: () => lifetime.isCurrent(),
                present: presentSessionServerStartDraftComposer,
            });
            if (recipe && recipe.kind !== 'submitted') {
                if (recipe.kind !== 'cancelled') setRefused({ ok: false, errorCode: recipe.reason, error: recipe.reason });
                return;
            }
            const status = await machineScmStatusSnapshot(chosen.machineId, { cwd: chosen.rootPath }, lifetime.scope);
            if (!status.success) { const code = status.errorCode ?? 'unavailable'; setRefused({ ok: false, errorCode: code, error: code }); return; }
            const baseCommit = status.snapshot?.branch.headOid;
            if (!baseCommit) { setRefused({ ok: false, errorCode: 'base_changed', error: 'base_changed' }); return; }
            const input = DeploymentPrepareInputV1Schema.parse({ projectSourceId, sourceRevision: source.revision, repository, baseCommit,
                workspace: { kind: 'workspace-ref', serverId: chosen.serverId, id: chosen.id },
                ...(props.environmentId ? { environmentId: props.environmentId } : {}),
                ...(partial?.sessionRef ? { sessionRef: partial.sessionRef } : {}),
                ...(recipe?.kind === 'submitted' ? { sessionDraft: recipe.draft } : {}),
                ...(props.mode === 'import' ? { importFrom: { tool, configurationPaths } } : {}) });
            const result = await createDeploymentActions(lifetime, projectSourceId).prepare(input, chosen.machineId);
            if (result.kind === 'handedOff') openSession(result.sessionRef);
            else if (result.kind === 'partial') {
                if (result.sessionRef) props.onSessionAvailable(result.sessionRef, readAtHandoff);
                setPartial(result); setRefused({ ok: false, errorCode: result.reason, error: result.reason });
            }
            else setRefused({ ok: false, errorCode: result.reason, error: result.reason });
        } catch (error) {
            const code = failureCode(error);
            setRefused(projectActionExecuteFailure({ ok: false, errorCode: code, error: code,
                ...(error instanceof HappyError ? error : {}) }));
        }
        finally { retired.dispose(); authoring.current = null; setBusy(false); }
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
            {props.mode === 'prepare' ? <DeploymentPreparationRecognized read={recognized.read} onRetry={recognized.retry} /> : null}
            {props.mode === 'prepare' && repository ? <PreparationProposal /> : null}
            {props.mode === 'import' ? <ItemGroup header="none">
                <Item title={t('projects.deployments.preparation.tool')} accessoryLayout="stacked" rightElement={
                    <FieldTextInput testID="project-deployments.import.tool" value={tool} onChangeText={setTool} editable={!busy}
                        autoCapitalize="none" accessibilityLabel={t('projects.deployments.preparation.tool')} />} />
                <Item title={t('projects.deployments.preparation.paths')} accessoryLayout="stacked" rightElement={
                    <FieldTextInput testID="project-deployments.import.paths" value={paths} onChangeText={setPaths} editable={!busy}
                        multiline minLines={3} monospace autoCapitalize="none" accessibilityLabel={t('projects.deployments.preparation.paths')} />} />
            </ItemGroup> : null}
            {refused ? <SurfaceStateCard testID="project-deployments.prepare.refused" size="line" kind="error" title={t('common.error')}
                reason={refusal ?? undefined} diagnosticCode={refused.errorCode} diagnosticDetail={refused.requestId}
                {...(partial?.sessionRef ? { action: { label: t('common.open'), testID: 'project-deployments.prepare.session',
                    onPress: () => { if (partial.sessionRef) openSession(partial.sessionRef); } } } : {})} /> : null}
            {setChrome ? null : footer}
        </View>
    </ListPresentationProvider>;
}
