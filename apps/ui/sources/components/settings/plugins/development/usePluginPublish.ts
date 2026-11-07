import * as React from 'react';
import { useStore } from 'zustand';
import {
    PluginPublicationActionOutputSchemas,
    type PluginPublicationPrepared,
    type PluginPublishInspectResult,
    type PluginPublishResult,
    type PluginPublicationGithubInput,
    type PluginPublishActionInput,
    PluginPublicationGithubInputSchema,
    type PluginPublicationEffectResult,
} from '@happier-dev/protocol/actions/actionSpecs';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { type ActionExecuteResult, isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ForgeReleaseActionResultSchemasV1, type ForgeReleasePageV1 } from '@happier-dev/triage-protocol/releases/v1';
import { triagePagedPanelInitialState, triagePagedPanelReducer, type TriagePagedPanelStateV1 } from '@happier-dev/triage-protocol/v1';
import type { DaemonNpmRegistryProfileSnapshotV1 } from '@happier-dev/protocol/rpc/npmRegistryProfiles';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { describeNpmRegistryOperationError } from '@/components/settings/connectedServices/npm/npmRegistryOperationError';
import { useScopedPluginSettingsDaemonTargetBinding } from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { createPluginPublishDraft, fieldsFromPublication, publicationFromDraft, publicationDraftsEqual, type PluginPublishFields } from './pluginPublishDraft';
import type { PluginPublicationBotTemplate } from '@happier-dev/protocol/actions/actionSpecs';
import type { BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { HappyError } from '@/utils/errors/errors';

type ReadyInspection = Extract<PluginPublishInspectResult, { status: 'ready' }>;
type GithubTarget = Extract<NonNullable<NonNullable<ReadyInspection['github']>['publishTargets']>, { success: true }>['targets'][number];
export const githubPublicationTargetId = (target: GithubTarget) => JSON.stringify([target.provider.id, target.provider.baseUrl, target.owner, target.ownerKind]);
type PreparedDraft = Readonly<{ report: PluginPublicationPrepared; fields: PluginPublishFields }>;
type Profile = DaemonNpmRegistryProfileSnapshotV1['profiles'][number];
type PublicationAttempt = Readonly<{ input: PluginPublishActionInput; profile: Profile; integrity?: string; githubOutcomeUnconfirmed?: true }>;
type Pending = 'inspect' | 'prepare' | 'publish' | 'status' | 'githubHistory' | null;
type GithubHistory = TriagePagedPanelStateV1<ForgeReleasePageV1['rows'][number], string, ForgeReleasePageV1['incomplete']>;

/** One mounted publisher. Draft keystrokes never execute an Action or subscribe the whole page. */
export function usePluginPublish(options: Readonly<{ projectRoot: string; initialTarget?: MachineAdministrationTargetV1 | null;
    botTemplate?: PluginPublicationBotTemplate; previousRelease?: BotTemplateReleaseV1 | null; sourceScope?: ServerAccountScope }>) {
    const administration = useScopedPluginSettingsDaemonTargetBinding(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins,
        { initialTarget: options.initialTarget, enabled: true, explicitSelection: 'lastKnown', accountScope: options.sourceScope });
    const target = administration.executionTarget;
    const execution = useMountedActionExecution(options.sourceScope ?? administration.selectedServerIdentityId);
    // A template listing opens as the Bot it publishes; the Machine's inspection may refine it later.
    const [draft] = React.useState(() => createPluginPublishDraft({
        ...(options.projectRoot ? {} : { push: false }),
        ...(options.botTemplate ? { title: options.botTemplate.release.content.identity.name,
            description: options.botTemplate.release.content.identity.description,
            version: options.botTemplate.release.version, changelog: options.botTemplate.release.changelog ?? '' } : {}),
    }));
    const [inspection, setInspection] = React.useState<ReadyInspection | null>(null);
    const [profile, setProfile] = React.useState<Profile | null>(null);
    const [preparation, setPreparation] = React.useState<PreparedDraft | null>(null);
    const [result, setResult] = React.useState<PluginPublishResult | Extract<PluginPublishInspectResult, { status: 'failed' }> | null>(null);
    const [published, setPublished] = React.useState<PluginPublicationEffectResult | null>(null);
    const [attempt, setAttempt] = React.useState<PublicationAttempt | null>(null);
    const [githubHistory, setGithubHistory] = React.useState<GithubHistory | null>(null);
    const [mode, setMode] = React.useState<'direct' | 'staged'>('direct');
    const [pending, setPending] = React.useState<Pending>(null);
    const [error, setError] = React.useState<string | null>(null);
    const active = React.useRef<AbortController | null>(null);
    const seeded = React.useRef(false);
    const currentPreparation = useStore(draft, state => preparation !== null && publicationDraftsEqual(state.fields, preparation.fields));
    const canContinueGithub = Boolean(result?.status === 'published' && attempt?.input.github && !attempt.githubOutcomeUnconfirmed && !('github' in result && result.github));
    const alreadyPublished = profile?.origin === (published?.registryOrigin ?? attempt?.profile.origin)
        && published?.packageName === preparation?.report.packageName && published?.version === preparation?.report.version;
    const canPublish = currentPreparation && !alreadyPublished && !(profile?.origin === attempt?.profile.origin
        && attempt?.input.expectedArchiveIntegrity === preparation?.report.archiveIntegrity
        && result && ['published', 'awaiting_maintainer', 'outcome_unknown', 'version_conflict'].includes(result.status));
    // npm refused this exact version; the version field owns the correction until another version is chosen.
    const takenVersion = result?.status === 'version_conflict' ? attempt?.input.publication?.version ?? null : null;
    const scaffold = result && 'scaffold' in result ? result.scaffold : undefined;
    const scopeKey = JSON.stringify([administration.selectedServerIdentityId, administration.selection.selectedTarget?.machineId,
        execution.binding?.scope.accountId, options.projectRoot, options.botTemplate?.draftArtifactId,
        options.botTemplate?.expectedRevision, options.botTemplate?.release.releasedAtMs]);
    const hasSource = Boolean(options.projectRoot || options.botTemplate);
    const sourceInput = (projectRoot = options.projectRoot) => {
        const previousRelease = options.previousRelease;
        const botTemplate = options.botTemplate && previousRelease && draft.getState().fields.version.trim() === previousRelease.version
            ? { ...options.botTemplate, release: { ...options.botTemplate.release, releasedAtMs: previousRelease.releasedAtMs } }
            : options.botTemplate;
        return { ...(botTemplate ? { botTemplate } : {}), ...(projectRoot ? { projectRoot } : {}) };
    };

    React.useEffect(() => {
        seeded.current = false;
        setInspection(null); setProfile(null); setPreparation(null); setResult(null); setPublished(null); setAttempt(null); setPending(null);
        setGithubHistory(null);
        return () => { active.current?.abort(); active.current = null; };
    }, [scopeKey]);

    async function run<T>(kind: Exclude<Pending, null>, work: (signal: AbortSignal) => Promise<T>): Promise<Readonly<{ ok: true; result: T }> | Extract<ActionExecuteResult, { ok: false }> | undefined> {
        if (active.current || !administration.resolveCurrentExecutionTarget(target) || !hasSource || !execution.ready) return;
        const controller = new AbortController();
        active.current = controller; setPending(kind); setError(null);
        try {
            const value = await work(controller.signal);
            // Explicit Cancel may follow a committed upload. Only a retired mount/scope
            // loses interest in its reply; a same-scope terminal outcome remains useful.
            return active.current === controller ? { ok: true, result: value } : undefined;
        } catch (cause) {
            const errorCode = cause instanceof HappyError && cause.code ? cause.code : 'publication_action_failed';
            if (!controller.signal.aborted) setError(errorCode);
            return { ok: false, errorCode, error: errorCode };
        } finally {
            if (active.current === controller) { active.current = null; setPending(null); }
        }
    }

    async function executeValue(invocation: CurrentUiContextCommandInvocation | undefined,
        ...args: Parameters<typeof execution.execute>): Promise<unknown> {
        const outcome = await (invocation ? invocation.execute(execution, ...args) : execution.execute(...args));
        requireActionSuccess(outcome);
        return outcome.result;
    }

    async function inspect(cursor?: string, includeGithub = false, selectedProfile = profile, invocation?: CurrentUiContextCommandInvocation) {
        const fields = draft.getState().fields;
        const outcome = await run('inspect', async signal => PluginPublicationActionOutputSchemas['plugins.dev.publication.inspect'].parse(
            await executeValue(invocation, 'plugins.dev.publication.inspect', {
                ...sourceInput(), machineId: target?.machine.id,
                ...(selectedProfile ? { profileId: selectedProfile.profileId } : {}),
                ...(fields.packageName.trim() ? { packageName: fields.packageName.trim() } : {}), ...(cursor ? { cursor } : {}),
                ...(includeGithub ? { includeGithub: true } : {}),
            }, { signal })).result);
        if (!outcome?.ok) return outcome;
        const value = outcome.result;
        if (value.status === 'failed') { setResult(value); return outcome; }
        setInspection(previous => ({ ...value, ...(!value.github && previous?.github ? { github: previous.github } : {}),
            ...(cursor && previous ? { history: { ...value.history,
                versions: [...previous.history?.versions ?? [], ...value.history?.versions ?? []] } } : {}) }));
        if (!seeded.current) { draft.getState().patch(fieldsFromPublication(value.publication)); seeded.current = true; }
        if (includeGithub && value.github) {
            const current = draft.getState().fields;
            draft.getState().patch({
                ...(!current.remote && value.github.remote ? { remote: value.github.remote } : {}),
                ...(!current.branch && value.github.branch ? { branch: value.github.branch } : {}),
                ...(!current.repository && value.github.repository ? { repository: value.github.repository.repository } : {}),
                ...(value.github.repository ? { repositoryDeployment: value.github.repository.deployment } : {}),
                ...(!current.repositoryName && value.github.publishTargets?.success ? { repositoryName: value.github.publishTargets.defaultRepositoryName } : {}),
            });
        }
        return outcome;
    }

    // This is the selected page's initial read, never a global startup probe or an idle loop.
    const initialInspect = React.useRef(inspect);
    initialInspect.current = inspect;
    React.useEffect(() => { if (execution.ready && target) void initialInspect.current(); }, [scopeKey, execution.ready, target?.machine.id]);

    async function prepare(invocation?: CurrentUiContextCommandInvocation) {
        const fields = draft.getState().fields;
        const outcome = await run('prepare', async signal => PluginPublicationActionOutputSchemas['plugins.dev.publication.prepare'].parse(
            await executeValue(invocation, 'plugins.dev.publication.prepare', {
                ...sourceInput(options.botTemplate ? options.projectRoot : inspection?.projectRoot ?? options.projectRoot),
                machineId: target?.machine.id, ...(profile ? { profileId: profile.profileId } : {}),
                publication: publicationFromDraft(fields, fields.icon ? { ...inspection?.publication.icon, iconResourceId: fields.icon } : undefined),
            }, { signal })).result);
        if (!outcome?.ok) return outcome;
        const value = outcome.result;
        if (value.status === 'prepared') setPreparation({ report: value, fields });
        else { setPreparation(null); setResult(value); }
        return outcome;
    }

    async function connect(invocation?: CurrentUiContextCommandInvocation) {
        const expectedTarget = target;
        setError(null);
        const selected = await presentConnectSheet({ service: { kind: 'npm-registry-profile' },
            targetSelection: administration.selection, projectDir: inspection?.projectRoot, ...(profile ? { current: profile.profileId } : {}),
            onOperationError: code => {
                if (administration.resolveCurrentExecutionTarget(expectedTarget)) setError(describeNpmRegistryOperationError(code) ?? code);
            } });
        if (selected.kind !== 'dismissed' && administration.resolveCurrentExecutionTarget(expectedTarget)) {
            setProfile(selected.profile);
            return inspect(undefined, false, selected.profile, invocation);
        }
    }

    async function selectProfile(profileId: string, invocation?: CurrentUiContextCommandInvocation) {
        const selected = inspection?.profiles.find(value => value.profileId === profileId);
        if (!selected) return;
        setProfile(selected);
        return inspect(undefined, false, selected, invocation);
    }

    async function publish(github?: PluginPublicationGithubInput, githubOnly = false, invocation?: CurrentUiContextCommandInvocation) {
        const selectedProfile = githubOnly ? attempt?.profile : profile;
        if (!selectedProfile || !preparation || (!githubOnly && !canPublish)) return;
        const input: PluginPublishActionInput = githubOnly && attempt ? { ...attempt.input, github, githubOnly: true } : {
            ...sourceInput(options.botTemplate ? options.projectRoot : preparation.report.projectRoot ?? options.projectRoot),
            machineId: target?.machine.id, profileId: selectedProfile.profileId,
            publication: preparation.report.publication, expectedArchiveIntegrity: preparation.report.archiveIntegrity,
            access: 'public', mode, ...(github ? { github } : {}),
        };
        let publicationExecution: ActionExecuteResult | undefined;
        const outcome = await run('publish', async signal => {
            // The exact reviewed archive's npm SRI is available before the upload,
            // including when transport cancellation prevents a terminal receipt.
            setAttempt({ input, profile: selectedProfile, integrity: preparation.report.npmIntegrity });
            let issued = false;
            try {
                const operation = { signal, onTransportIssued: () => { issued = true; } };
                const outcome = await (invocation ? invocation.execute(execution, 'plugins.dev.publish', input, operation)
                    : execution.execute('plugins.dev.publish', input, operation));
                if (!outcome.ok) {
                    publicationExecution = outcome;
                    if (isActionOutcomeUnknownErrorCodeV1(outcome.errorCode) || outcome.effectAttempted === true
                        || issued && outcome.effectAttempted !== false) {
                        return { result: { status: 'outcome_unknown' as const, packageName: preparation.report.packageName,
                            version: preparation.report.version, integrity: preparation.report.npmIntegrity, code: outcome.errorCode },
                            ...(input.github ? { githubOutcomeUnconfirmed: true as const } : {}) };
                    }
                    if (githubOnly && result && result.status !== 'review_required' && !('diagnostics' in result)) {
                        return { result: { ...result, code: outcome.errorCode } };
                    }
                    return { result: { status: 'failed' as const, code: outcome.errorCode } };
                }
                const value = PluginPublicationActionOutputSchemas['plugins.dev.publish'].parse(outcome.result).result;
                publicationExecution = outcome;
                return { result: value };
            } catch {
                if (!issued) return { result: { status: 'failed' as const, code: 'publication_action_failed' } };
                return { result: { status: 'outcome_unknown' as const, packageName: preparation.report.packageName,
                    version: preparation.report.version, integrity: preparation.report.npmIntegrity },
                    ...(input.github ? { githubOutcomeUnconfirmed: true as const } : {}) };
            }
        });
        if (!outcome?.ok) return outcome;
        const settled = outcome.result;
        const value = settled.result;
        setAttempt({ input, profile: selectedProfile, ...('githubOutcomeUnconfirmed' in settled && settled.githubOutcomeUnconfirmed ? { githubOutcomeUnconfirmed: true } : {}),
            ...('integrity' in value && value.integrity ? { integrity: value.integrity } : {}) });
        if (value.status === 'review_required') setPreparation({ report: value.preparation, fields: preparation.fields });
        if (value.status === 'published') setPublished(value);
        setResult(value);
        return publicationExecution ?? { ok: false as const, errorCode: 'publication_action_failed', error: 'publication_action_failed' };
    }

    function selectedGithub(): PluginPublicationGithubInput | undefined {
        const fields = draft.getState().fields;
        if (!fields.github) return;
        const github = inspection?.github;
        const targets = github?.publishTargets;
        const selected = targets?.success ? targets.targets.find(candidate => githubPublicationTargetId(candidate) === fields.githubOwner) : undefined;
        const repository = fields.createRepository && selected ? normalizeScmHostingRepositoryIdentity({
            kind: selected.provider.kind, deployment: selected.provider.baseUrl, repository: `${selected.owner}/${fields.repositoryName.trim()}`,
        }) : github?.repository ?? normalizeScmHostingRepositoryIdentity({
            kind: 'github', deployment: fields.repositoryDeployment.trim(), repository: fields.repository.trim(),
        });
        if (!repository) return;
        const value = PluginPublicationGithubInputSchema.safeParse({
            repository,
            ...(fields.createRepository && selected ? { createRepository: {
                cwd: inspection?.projectRoot, providerKind: 'github', providerId: selected.provider.id, providerBaseUrl: selected.provider.baseUrl,
                owner: selected.owner, ownerKind: selected.ownerKind, repositoryName: fields.repositoryName.trim(), visibility: 'public',
                description: fields.description, remoteName: fields.remote.trim(), remoteUrlKind: 'https', pushCurrentBranch: false,
            } } : {}),
            ...(fields.push ? { source: { remote: fields.remote.trim(), branch: fields.branch.trim(),
                ...(fields.commit ? { commit: { message: fields.commitMessage.trim(), paths: fields.commitPaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean) } } : {}),
            } } : {}),
            ...(fields.release ? { release: { tagName: `v${preparation?.report.version ?? fields.version}`, targetCommitish: fields.branch.trim(),
                name: `${fields.title} ${preparation?.report.version ?? fields.version}`, body: fields.changelog, prerelease: false, makeLatest: 'true' } } : {}),
        });
        return value.success ? value.data : undefined;
    }

    async function publishSelected(invocation?: CurrentUiContextCommandInvocation) {
        const github = selectedGithub();
        if (draft.getState().fields.github && !github) { setError('publication_github_selection_required'); return; }
        return publish(github, false, invocation);
    }

    async function retryGithub(invocation?: CurrentUiContextCommandInvocation) {
        if (!attempt?.input.github || !result || attempt.githubOutcomeUnconfirmed) return;
        const previous = 'github' in result ? result.github : undefined;
        if (previous?.status === 'outcome_unknown' || (!previous && result.status !== 'published')) return;
        const selectedRemote = draft.getState().fields.remote.trim();
        const github: PluginPublicationGithubInput = { ...attempt.input.github,
            ...(previous?.phase === 'repository' && attempt.input.github.createRepository ? {
                createRepository: { ...attempt.input.github.createRepository, remoteName: selectedRemote },
                ...(attempt.input.github.source ? { source: { ...attempt.input.github.source, remote: selectedRemote } } : {}),
            } : previous ? { createRepository: undefined } : {}),
            ...(previous?.pushed ? { source: undefined } : previous?.commitSha && attempt.input.github.source
                ? { source: { ...attempt.input.github.source, commit: undefined } } : {}),
            ...(previous?.releaseId && attempt.input.github.release ? { release: { ...attempt.input.github.release, releaseId: previous.releaseId } } : {}),
        };
        return publish(github, true, invocation);
    }

    async function readGithubHistory(cursor?: string, invocation?: CurrentUiContextCommandInvocation) {
        const repository = inspection?.github?.repository;
        if (!repository || active.current || !target || !execution.ready) return;
        const outcome = await run('githubHistory', async signal => {
            setGithubHistory(previous => triagePagedPanelReducer(previous ?? triagePagedPanelInitialState(),
                { kind: cursor ? 'requestStarted' : 'refreshStarted', token: 0 }));
            const raw = await executeValue(invocation, 'action.invoke', {
                    action: { pluginId: 'happier.scm.forge.github', localId: 'github/releases/list' },
                    input: { repository, ...(cursor ? { cursor } : {}) },
                }, { signal, externalActionTarget: { kind: 'machine', machineId: target.machine.id } });
            return ForgeReleaseActionResultSchemasV1.listReleases.parse(raw);
        });
        if (!outcome) return;
        const value = outcome.ok ? outcome.result : null;
        setGithubHistory(previous => triagePagedPanelReducer(previous ?? triagePagedPanelInitialState(),
            value?.kind === 'value' ? { kind: 'pageSettled', token: 0, page: value.value }
                : { kind: 'pageFailed', token: 0, failure: value?.kind === 'unavailable' ? value.failure.code : 'publication_github_history_unavailable' }));
        return outcome;
    }

    async function checkPublication(invocation?: CurrentUiContextCommandInvocation) {
        if (!attempt?.input.profileId || !attempt.integrity || !attempt.input.publication?.packageName || !attempt.input.publication.version) return;
        const outcome = await run('status', async signal => PluginPublicationActionOutputSchemas['plugins.dev.publication.status'].parse(
            await executeValue(invocation, 'plugins.dev.publication.status', {
                machineId: attempt.input.machineId, profileId: attempt.input.profileId,
                packageName: attempt.input.publication?.packageName, version: attempt.input.publication?.version,
                integrity: attempt.integrity,
            }, { signal })).result);
        if (!outcome?.ok) return outcome;
        const value = outcome.result;
        if (value) {
            if (value.status === 'published') setPublished(value);
            setResult(previous => previous && 'github' in previous && !('diagnostics' in value) ? { ...value, github: previous.github } : value);
        }
        return outcome;
    }

    async function openExternal(url: string) {
        const outcome = await execution.execute('links.openExternal', { url });
        setError(outcome.ok ? null : outcome.errorCode);
        return outcome;
    }

    return { administration, draft, inspection, profile, preparation: preparation?.report ?? null, currentPreparation, canContinueGithub, canPublish,
        githubHistory, readGithubHistory, scaffold,
        result, published, attempt, pending, error, mode, setMode, inspect, prepare, connect, publishSelected, retryGithub, checkPublication,
        selectProfile, openExternal, takenVersion,
        /** A pending publication holds the draft it publishes: fields and the draft patch command are read-only. */
        readOnly: pending === 'publish',
        hasSourceProject: Boolean(options.projectRoot),
        available: execution.ready && administration.selection.canExecute && hasSource,
        cancel: () => active.current?.abort(),
    };
}

export type PluginPublishController = ReturnType<typeof usePluginPublish>;
