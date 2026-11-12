import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { DeploymentMoveToRepositoryCreateRepositoryV1Schema, type DeploymentMoveToRepositoryInputV1, type DeploymentMoveToRepositoryResultV1 } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import type { ProjectAccountWorkspaceRefKeyV1 } from '@happier-dev/protocol/projects/workspaceRefKeyV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { ProjectSourceWorkspaceChoice, useProjectSourceWorkspaceChoice } from '@/components/projects/sources/ProjectSourceWorkspaceChoice';
import { seedAndOpenProjectDraft } from '@/components/projects/activation/projectOpenDraftSeed';
import { showProjectOpenDialog } from '@/components/projects/activation/projectOpenPresentation';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { createActionInputForm } from '@/components/plugins/actions/actionInputForm';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { localizeBuiltinInputHints } from '@/text/builtinInputPrompts';
import { useProjectSourceAddress } from '@/components/projects/sources/useProjectSourceAddress';
import { presentProjectSourceAddressRefusal } from '@/components/projects/sources/resolveProjectSourceAddress';
import type { createDeploymentActions } from './deploymentActions';
import { readDeploymentActionError, type DeploymentActionOutcome } from './deploymentActionOutcome';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';

const ID = 'project-deployments.environment.moveRepository';
const COPY = 'projects.deployments.settingsSections.moveToRepository' as const;
type MoveInput = Omit<DeploymentMoveToRepositoryInputV1, 'serverId'>;
type Move = ReturnType<typeof createDeploymentActions>['moveToRepository'];
type Props = Readonly<{ detail: DeploymentEnvironmentReadDetailV1; lifetime: ServerAccountScopeLifetime | null;
    move: Move | null; review: DeploymentReviewHandle; onChanged: () => void; machineName: (machineId: string) => string }>;
type Progress = Readonly<{ result: DeploymentMoveToRepositoryResultV1 | null; captured: MoveInput | null }>;

/** A secondary door; repository reads and checkout subscriptions belong only to the opened leaf. */
export function MoveDefinitionToRepository(props: Props) {
    const [open, setOpen] = React.useState(false);
    const [progress, setProgress] = React.useState<Progress>({ result: null, captured: null });
    const [running, setRunning] = React.useState(false);
    if (props.detail.content.definition.kind !== 'stored' || !props.move || !props.lifetime) return null;
    return <ItemGroup testID={ID} title={t(`${COPY}.title`)} description={t(`${COPY}.body`)}
        action={<SectionActionButton testID={`${ID}.open`} title={t(`${COPY}.title`)} icon="git-branch"
            expanded={open} disabled={running} onPress={() => setOpen(value => !value)} />}>
        {open ? <MoveRepositoryFields {...props} lifetime={props.lifetime} move={props.move}
            progress={progress} onProgress={setProgress} running={running} onRunning={setRunning} /> : null}
    </ItemGroup>;
}

function MoveRepositoryFields(props: Props & Readonly<{ lifetime: ServerAccountScopeLifetime; move: Move;
    progress: Progress; onProgress: (progress: Progress) => void; running: boolean; onRunning: (running: boolean) => void }>) {
    const definition = props.detail.content.definition;
    const [workspaceKey, setWorkspaceKey] = React.useState<ProjectAccountWorkspaceRefKeyV1 | null>(null);
    const [createRepository, setCreateRepository] = React.useState<MoveInput['createRepository']>();
    const [repositoryAddress, setRepositoryAddress] = React.useState('');
    const [pullRequestUrl, setPullRequestUrl] = React.useState('');
    const [sourceRepository, setSourceRepository] = React.useState<ProjectSourceRepositorySelectorV1>();
    const repositoryChoice = sourceRepository ? readScmHostingRepositoryIdentity({ ...sourceRepository.provider,
        nameWithOwner: sourceRepository.repository.nameWithOwner }) : null;
    const address = useProjectSourceAddress(props.lifetime.scope, selector => {
        setSourceRepository(selector); setCreateRepository(undefined);
    });
    const selection = useProjectSourceWorkspaceChoice({ lifetime: props.lifetime,
        sourceId: props.detail.environment.projectSourceId, value: workspaceKey, destination: Boolean(createRepository), repository: repositoryChoice ?? undefined });
    const [path, setPath] = React.useState(() => `deploy/${props.detail.content.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'}/compose.yaml`);
    const { result, captured } = props.progress;
    const running = props.running;
    const [failure, setFailure] = React.useState<DeploymentActionOutcome | null>(null);
    const [confirmedPath, setConfirmedPath] = React.useState(false);
    const busy = React.useRef(false);
    const run = async (input: MoveInput) => {
        if (busy.current) return;
        busy.current = true; props.onRunning(true); setFailure(null);
        try {
            const answer = await props.move(input, input.mode === 'apply' ? { confirmed: true } : undefined);
            let nextInput = input;
            if (answer.kind === 'pullRequest' && answer.repository) {
                const { createRepository: _create, ...existing } = input;
                nextInput = { ...existing, ...answer.repository };
            }
            props.onProgress({ result: answer, captured: nextInput });
            if (answer.kind === 'switched') props.onChanged();
        } catch (error) {
            const outcome = readDeploymentActionError(error);
            setFailure(outcome);
            if (outcome.kind === 'approval') props.review.request(outcome.artifactId);
        } finally { busy.current = false; props.onRunning(false); }
    };
    const preview = (pullRequestReference?: MoveInput['pullRequestReference']) => {
        if (definition.kind !== 'stored') return;
        if (!workspaceKey || !selection.workspace) return;
        if (!createRepository && (!selection.repository || !workspaceKey || !selection.baseCommit || !selection.baseBranch)) return;
        setConfirmedPath(false);
        void run({ mode: 'preview', environmentId: props.detail.environment.id,
            definition: { contentRevision: definition.contentRevision, composeDigest: definition.composeDigest },
            path, workspace: workspaceKey, ...(createRepository ? { createRepository } : { repository: selection.repository!,
                baseCommit: selection.baseCommit!, baseBranch: selection.baseBranch! }),
            ...(pullRequestReference ? { pullRequestReference } : {}),
            ...(sourceRepository && !createRepository ? { sourceRepository } : {}),
            selectors: { profiles: definition.profiles, services: definition.services,
                ...(definition.primaryService ? { primaryService: definition.primaryService } : {}) } });
    };
    const chooseCreateRepository = () => {
        const spec = getActionSpec('scm.hostingRepository.publish');
        if (!spec?.inputHints) return;
        const schema = DeploymentMoveToRepositoryCreateRepositoryV1Schema;
        const hints = localizeBuiltinInputHints(spec.inputHints);
        const form = createActionInputForm({ accountLifetime: props.lifetime,
            presentation: { title: t(`${COPY}.createRepository`), description: null,
                inputHints: { ...hints, fields: hints.fields.filter(field => field.path.split('.')[0]! in schema.shape) } },
            initialInput: createRepository,
            submit: async candidate => {
                const parsed = schema.safeParse(candidate);
                if (!parsed.success) return { ok: false, code: 'invalid_request' as const };
                setCreateRepository(parsed.data);
                return { ok: true };
            } });
        presentActionInputForm({ form, actionId: spec.id });
    };
    const destinationMachineId = selection.workspace?.machineId ?? props.detail.environment.controllerMachineId;
    const chooseDestination = async () => {
        if (busy.current || !destinationMachineId) return;
        busy.current = true; props.onRunning(true); setFailure(null);
        try {
            const selected = await openMachinePathBrowserModal({ machineId: destinationMachineId,
                serverId: props.lifetime.scope.serverId, title: t(`${COPY}.chooseDestination`),
                selectionMode: 'directory', allowMachineChange: true });
            if (!selected) return;
            await seedAndOpenProjectDraft({ lifetime: props.lifetime,
                selection: { serverId: props.lifetime.scope.serverId, machineId: selected.machineId,
                    source: { kind: 'folder', path: selected.path }, materialization: { kind: 'attach' } },
                navigate: route => showProjectOpenDialog(route, result => {
                    if (props.lifetime.isCurrent()) setWorkspaceKey({ kind: 'workspace-ref',
                        serverId: result.workspace.serverId, id: result.workspace.workspaceId });
                }) });
        } catch (error) { setFailure(readDeploymentActionError(error)); }
        finally { busy.current = false; props.onRunning(false); }
    };
    const editable = result === null || result.kind === 'refused' || result.kind === 'conflict';
    const continuation = result && 'continuation' in result ? result.continuation : null;
    const pullRequest = result?.kind === 'pullRequestStatus' || result?.kind === 'reviewMerged'
        ? result.pullRequest ?? continuation?.pullRequest : continuation?.pullRequest;
    const issue = result?.kind === 'refused' || result?.kind === 'conflict' ? result.reason
        : result?.kind === 'partial' ? result.errorCode : null;
    const retryInput = captured && result?.kind === 'partial' ? { ...captured,
        ...(result.repositoryWork ? { repositoryWork: result.repositoryWork } : {}),
        ...(result.continuation ? { continuation: result.continuation } : {}) } : null;
    const previewFiles = result?.kind === 'preview' || result?.kind === 'previewCreate' ? result.review.files ?? [{ path: result.review.path,
        before: result.kind === 'preview' ? result.review.before : null, content: result.review.document }] : [];
    const existingPath = previewFiles.some(file => file.before !== null);
    const mergedFiles = new Map<string, { before: string; content: string }>();
    if (result?.kind === 'reviewMerged') {
        for (const file of result.review.currentPublicFiles ?? []) mergedFiles.set(file.path, { before: file.content, content: '' });
        for (const file of result.review.mergedPublicFiles ?? []) mergedFiles.set(file.path,
            { before: mergedFiles.get(file.path)?.before ?? '', content: file.content });
    }
    return <>
        {editable ? <>
            {selection.status === 'loading' || selection.status === 'initial'
                ? <SurfaceStateCard size="line" kind="loading" title={t(`${COPY}.sourceLoading`)} />
                : !selection.source ? <SurfaceStateCard size="line" kind="error" title={t(`${COPY}.sourceFailed`)} />
                : <>
                    {selection.repository && !createRepository ? <Item title={selection.repository.repository} subtitle={selection.repository.deployment} showChevron={false} /> : null}
                    {!selection.source.repository ? <>
                        <Item title={t(`${COPY}.repositoryAddress`)} accessoryLayout="stacked" showChevron={false}
                            rightElement={<FieldTextInput testID={`${ID}.repositoryAddress`} value={repositoryAddress}
                                onChangeText={value => { setRepositoryAddress(value); address.withdrawRefusal(); }}
                                editable={!running} accessibilityLabel={t(`${COPY}.repositoryAddress`)} />} />
                        <Item title={t(`${COPY}.chooseRepository`)} showChevron={false} rightElement={<SectionActionButton
                            testID={`${ID}.chooseRepository`} title={t(`${COPY}.chooseRepository`)} icon="git-branch"
                            disabled={running || !repositoryAddress.trim()} onPress={() => { void address.resolve(repositoryAddress, selection.workspace?.machineId); }} />} />
                        {address.refusal ? <SurfaceStateCard size="line" kind="warning"
                            title={presentProjectSourceAddressRefusal(address.resolution, address.refusal, props.machineName)} /> : null}
                    </> : null}
                    {!selection.source.repository ? <Item title={createRepository?.repositoryName ?? t(`${COPY}.createRepository`)} showChevron={false}
                        rightElement={<SectionActionButton testID={`${ID}.createRepository`} title={t(`${COPY}.createRepository`)}
                            icon="plus" disabled={running} onPress={chooseCreateRepository} />} /> : null}
                    <ProjectSourceWorkspaceChoice model={selection} value={workspaceKey} onChange={setWorkspaceKey}
                        disabled={running} showBase={!createRepository} testID={`${ID}.workspace`} />
                    {createRepository ? <Item title={t(`${COPY}.chooseDestination`)} showChevron={false}
                        rightElement={<SectionActionButton testID={`${ID}.chooseDestination`} title={t(`${COPY}.chooseDestination`)}
                            icon="folder" disabled={running || !destinationMachineId} onPress={() => { void chooseDestination(); }} />} /> : null}
                    <Item title={t(`${COPY}.path`)} accessoryLayout="stacked" showChevron={false}
                        rightElement={<FieldTextInput testID={`${ID}.path.input`} value={path} onChangeText={setPath}
                            editable={!running} accessibilityLabel={t(`${COPY}.path`)} />} />
                    <Item title={t(`${COPY}.preview`)} showChevron={false} rightElement={<SectionActionButton
                        testID={`${ID}.preview`} title={t(`${COPY}.preview`)} icon="git-diff" loading={running}
                        disabled={running || !path.trim() || !selection.workspace || !createRepository && (!selection.repository || !selection.baseCommit || !selection.baseBranch)}
                        onPress={() => preview()} />} />
                    {!createRepository ? <>
                        <Item title={t(`${COPY}.existingPullRequest`)} accessoryLayout="stacked" showChevron={false}
                            rightElement={<FieldTextInput testID={`${ID}.pullRequestUrl`} value={pullRequestUrl}
                                onChangeText={setPullRequestUrl} editable={!running} accessibilityLabel={t(`${COPY}.existingPullRequest`)} />} />
                        <Item title={t(`${COPY}.continueExisting`)} showChevron={false} rightElement={<SectionActionButton
                            testID={`${ID}.continueExisting`} title={t(`${COPY}.continueExisting`)} icon="git-pull-request"
                            disabled={running || !pullRequestUrl.trim() || !selection.workspace || !selection.repository || !selection.baseCommit || !selection.baseBranch}
                            onPress={() => preview({ url: pullRequestUrl.trim() })} />} />
                    </> : null}
                </>}
        </> : null}
        {(result?.kind === 'preview' || result?.kind === 'previewCreate') && captured ? <>
            {previewFiles.map(file => <DiffViewer key={file.path} testID={`${ID}.diff.${file.path}`} mode="text" filePath={file.path}
                oldText={file.before ?? ''} newText={file.content} wrapLines />)}
            {existingPath ? <Item title={t(`${COPY}.confirmPath`)} subtitle={t(`${COPY}.sharedPath`)}
                rightElement={<Switch testID={`${ID}.confirmPath`} value={confirmedPath} onValueChange={setConfirmedPath} disabled={running} />} /> : null}
            <Item title={t(`${COPY}.review`)} showChevron={false} rightElement={<SectionActionButton
                testID={`${ID}.apply`} title={t(`${COPY}.review`)} icon="git-pull-request" loading={running}
                disabled={running || existingPath && !confirmedPath}
                onPress={() => {
                    if (result.kind === 'previewCreate') {
                        void run({ ...captured, mode: 'apply', createRepository: result.review.createRepository,
                            path: result.review.path, workspace: result.review.workspace, selectors: result.review.selectors });
                    } else {
                        const review = result.review; const { createRepository: _create, ...existing } = captured;
                        void run({ ...existing, mode: 'apply', repository: review.repository, path: review.path, workspace: review.workspace,
                            baseCommit: review.baseCommit, baseBranch: review.baseBranch, selectors: review.selectors });
                    }
                }} />} />
            <Item title={t('common.back')} showChevron={false} onPress={() => { if (!running) props.onProgress({ result: null, captured: null }); }} />
        </> : null}
        {pullRequest ? <Item testID={`${ID}.pullRequest`} title={pullRequest.title}
            subtitle={`${pullRequest.url}\n${t(`${COPY}.pullRequestBody`)}`}
            onPress={() => { void requestOpenExternalUrl(pullRequest.url); }} /> : null}
        {pullRequest && result?.kind !== 'reviewMerged' ? <>
            <Item title={t(`${COPY}.continue`)} showChevron={false} rightElement={<SectionActionButton
                testID={`${ID}.continue`} title={t(`${COPY}.continue`)} icon="arrow-right" disabled={running}
                onPress={() => { if (captured) void run({ ...captured,
                    mode: captured.pullRequestReference ? 'preview' : 'apply', ...(continuation ? { continuation } : {}) }); }} />} />
        </> : null}
        {result?.kind === 'reviewMerged' && captured ? <>
            <SurfaceStateCard size="line" kind="warning" title={t(`${COPY}.mergedTitle`)} reason={t(`${COPY}.mergedBody`)} />
            <DiffViewer testID={`${ID}.mergedDiff`} mode="text" filePath={result.continuation?.path ?? captured.path}
                oldText={result.review.currentDocument} newText={result.review.mergedDocument} wrapLines />
            {[...mergedFiles].map(([filePath, file]) => <DiffViewer
                key={filePath} testID={`${ID}.mergedDiff.${filePath}`} mode="text" filePath={filePath}
                oldText={file.before} newText={file.content} wrapLines />)}
            <Item title={t(`${COPY}.useMerged`)} showChevron={false} rightElement={<SectionActionButton
                testID={`${ID}.useMerged`} title={t(`${COPY}.useMerged`)} icon="git-merge" disabled={running}
                onPress={() => { void run({ ...captured, mode: 'apply',
                    ...(!captured.pullRequestReference && result.continuation ? { continuation: result.continuation } : {}),
                    useMergedVersion: result.review }); }} />} />
        </> : null}
        {result?.kind === 'switched' ? <SurfaceStateCard size="line" kind="success" title={t(`${COPY}.switched`)} /> : null}
        {issue ? <SurfaceStateCard testID={`${ID}.refused`} size="line" kind="error"
            title={t(`${COPY}.refused`)} diagnosticCode={issue}
            {...(issue === 'checkout_owner_required' ? { reason: t(`${COPY}.checkoutOwnerRequired`) } : {})}
            {...(retryInput ? { action: { label: t('common.retry'), onPress: () => { void run(retryInput); } } } : {})} /> : null}
        {failure?.kind === 'approval' ? <SurfaceStateCard testID={`${ID}.approval`} size="line" kind="warning"
            title={t(`${COPY}.approval`)} reason={t(`${COPY}.approvalBody`)}
            action={{ label: t(`${COPY}.review`), onPress: () => props.review.open(failure.artifactId) }} />
            : failure?.kind === 'refused' ? <SurfaceStateCard size="line" kind="error" title={t(`${COPY}.refused`)} diagnosticCode={failure.code} /> : null}
    </>;
}
