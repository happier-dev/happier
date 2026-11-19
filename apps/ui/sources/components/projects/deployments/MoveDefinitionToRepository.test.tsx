import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeploymentReadControllerV1, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { DeploymentMoveToRepositoryInputV1Schema, type DeploymentMoveToRepositoryInputV1 } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import type { ActionInputForm } from '@/components/plugins/actions/actionInputForm';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ItemList } from '@/components/ui/lists/ItemList';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const modal = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock());
vi.mock('@/modal', () => modal.module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentActions } = await import('./deploymentActions');
const { DeploymentEnvironmentSettingsPanel } = await import('./DeploymentEnvironmentSettingsPanel');
const { ProjectSourceWorkspaceChoice } = await import('../sources/ProjectSourceWorkspaceChoice');
const { ProjectOpenScreen } = await import('../activation/ProjectOpenScreen');
const { storage } = await import('@/sync/domains/state/storage');
afterEach(async () => { await standardCleanup(); await homes.reset(); modal.spies.show.mockClear(); });

it('offers Move for a stored definition through Environment Settings without reading repository detail before it opens', async () => {
    const serverId = await homes.addHome({ name: 'Deployments', serverUrl: 'https://move-repository.test',
        serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'account-owner', currentAccount: true });
    const base = createDeploymentEnvironmentDetailV1();
    const stored = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }),
        content: { ...base.content, definition: { kind: 'stored', contentRevision: 1,
            composeDigest: `sha256:${'a'.repeat(64)}`, document: 'services:\n  app:\n    image: app:1\n',
            publicFiles: [], services: [], profiles: [] } } });
    const detail = { ...stored, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(stored), memberVersions: {}, secretRevisions: [], builtInUrls: [] };
    const scope = { serverId, accountId: 'account-owner', projectSourceId: detail.environment.projectSourceId };
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const controller = createDeploymentReadControllerV1({ scope, transport: {
        listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readEnvironment: async () => ({ ok: true, value: detail }),
        listHistory: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readReceipt: async () => ({ ok: false, failure: { code: 'not_found', retryable: false } }),
    } });
    const screen = await renderAccountScreen(<ItemList><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
        definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change: () => {} }}
        demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
        lifetime={lifetime} editing={{ actions: createDeploymentActions(lifetime, scope.projectSourceId), serverId,
            review: { pendingId: null, request() {}, open() {} }, onChanged() {} }} /></ItemList>);
    // Settings already owns the editor and exposes its Move action.
    expect(screen.findByTestId('project-deployments.environment.moveRepository.open')).not.toBeNull();
    expect(homes.requestsFor(`/v1/projects/sources/${detail.environment.projectSourceId}`)).toHaveLength(0);
    expect(screen.findByTestId('project-deployments.environment.moveRepository.path.input')).toBeNull();
    await act(async () => { controller.retire(); });
});

it.each(['existing', 'attach', 'create', 'create-new', 'resume'] as const)('reviews every file from %s repository selection and switches only after explicit merged acceptance', async repositoryChoice => {
    const creating = repositoryChoice === 'create' || repositoryChoice === 'create-new';
    const serverIdentityId = `srv_${'e'.repeat(32)}`;
    const serverId = await homes.addHome({ name: 'Move review', serverUrl: 'https://move-review.test',
        serverIdentityId, accountId: 'account-owner', currentAccount: true });
    const base = createDeploymentEnvironmentDetailV1();
    const definition = { kind: 'stored' as const, contentRevision: 3, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: 'services:\n  app:\n    image: app:3\n', publicFiles: [{ path: 'app.conf', content: 'version=3' }], services: [], profiles: [] };
    const stored = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }),
        content: { ...base.content, name: 'Production App', definition } });
    const detail = { ...stored, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(stored), memberVersions: {}, secretRevisions: [], builtInUrls: [] };
    const scope = { serverId, accountId: 'account-owner', projectSourceId: detail.environment.projectSourceId };
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/app' };
    const workspace = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
    const path = 'deploy/production-app/compose.yaml';
    const pin = { contentRevision: definition.contentRevision, composeDigest: definition.composeDigest };
    const source = { id: scope.projectSourceId, revision: 2 };
    const selector = { provider: { id: 'happier.scm.forge.github/github', kind: 'github' as const,
        displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: repository.repository }, protocol: 'https' as const };
    const checkout = { id: workspace.id, serverId, machineId: 'checkout-machine', rootPath: '/project', createdAtMs: 1,
        ...(repositoryChoice === 'create-new' ? {} : { repositoryIdentity: repository, source: { sourceId: source.id, revision: source.revision } }) };
    const { source: _checkoutSource, ...unboundCheckout } = checkout;
    const checkoutRefs = repositoryChoice === 'existing' ? [checkout,
        { ...checkout, id: 'other-source', source: { sourceId: 'another-source', revision: source.revision } },
        { ...checkout, id: 'old-source-revision', source: { sourceId: source.id, revision: source.revision - 1 } },
        { ...unboundCheckout, id: 'repository-only' },
    ] : [checkout];
    let admitted = repositoryChoice !== 'create-new';
    storage.getState().activateProfileScope(scope);
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    applyProjectAccountRowsFixture(storage, { workspaceRefs: admitted ? checkoutRefs : [] });
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        select: () => ({ body: createPlainProjectAccountRowListFixture({ workspaceRefs: admitted ? checkoutRefs : [] }) }),
    });
    storage.getState().applyMachines([createMachineFixture({ id: checkout.machineId, activeAt: Date.now() })], true,
        { sourceServerId: serverId, sourceAccountId: scope.accountId });
    storage.getState().markMachineListSettled(serverId);
    if (repositoryChoice !== 'create-new') storage.getState().updateWorkspaceScmSnapshot(checkout, { projectKey: 'checkout-machine:/project', fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: checkout.rootPath },
        branch: { head: 'main', headOid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0, hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } });
    const continuation = { definition: pin, source, path, document: definition.document, publicFiles: definition.publicFiles,
        headCommit: 'b'.repeat(40), pullRequest: { provider: { id: 'happier.scm.forge.github/github', kind: 'github' as const,
            displayName: 'GitHub', baseUrl: 'https://github.com' }, title: 'Move deployment', url: 'https://github.com/acme/app/pull/42',
            number: 42, baseBranch: 'main', headBranch: 'move-deployment', state: 'open' as const } };
    const merged = { currentDefinition: { contentRevision: 4, composeDigest: `sha256:${'c'.repeat(64)}` },
        currentDocument: 'services:\n  app:\n    image: app:4\n', currentPublicFiles: [{ path: 'app.conf', content: 'version=4' }],
        mergedCommit: 'd'.repeat(40), mergedDocument: 'services:\n  app:\n    image: app:merged\n',
        mergedPublicFiles: [{ path: 'app.conf', content: 'version=merged' }] };
    homes.answer(serverId, `/v1/projects/sources/${source.id}`, { body: { ok: true,
        source: { id: source.id, revision: source.revision, name: 'App', audience: [], createdByAccountId: scope.accountId,
            ...(repositoryChoice === 'existing' || repositoryChoice === 'resume' ? { repository: selector } : {}) }, canManage: true } });
    homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
        environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } });
    if (repositoryChoice === 'create-new') {
        homes.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
        const { configureSessionDraftRepository } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
        let row: SessionDraftRecordV2 | null = null;
        configureSessionDraftRepository({ scope, syncEnabled: true,
            cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
                getSessionContext: () => { throw new Error('No Session'); }, randomBytes: size => new Uint8Array(size) }),
            transport: { read: async () => row ? { status: 'present', record: row } : { status: 'absent' },
                list: async () => ({ items: row ? [row] : [] }), mutate: async request => {
                    row = { address: request.address, revision: (row?.revision ?? -1) + 1, content: request.content, createdAt: 1, updatedAt: 2 };
                    return { status: 'updated', record: row };
                } } });
        await answerExternalActionAccountForHome(homes, serverId, { actionId: 'projects.open', machineId: checkout.machineId,
            installationId: 'checkout-installation', tokenEpoch: 0, requesterInvocation: 'required', execute: async raw => {
                expect(OpenProjectInputV1Schema.parse(raw)).toMatchObject({ machineId: checkout.machineId,
                    source: { kind: 'folder', path: checkout.rootPath }, materialization: { kind: 'attach' } });
                admitted = true;
                const { sync } = await import('@/sync/sync');
                const rows = sync?.projectAccountRowsOwnerFor(scope);
                if (rows) await (await rows).refresh();
                else {
                    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                    const { createUiProjectAccountRowsClient } = await import('@/sync/api/projects/projectAccountRowsClient');
                    const account = await captureLazyActionAccountContext(serverId);
                    try { await createUiProjectAccountRowsClient(account).read(); }
                    finally { account.dispose(); }
                }
                return { kind: 'opened', workspace: { serverId, machineId: checkout.machineId, workspaceId: checkout.id,
                    rootPath: checkout.rootPath }, directory: checkout.rootPath, setup: 'notRequired' };
            } });
    }
    let addressResolved = false;
    const rpcMethods: string[] = [];
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, payload: unknown) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Malformed Move Socket RPC');
            rpcMethods.push(payload.method);
            expect(payload.method).toBe(`${checkout.machineId}:scm.hostingRepository.resolveAddress`);
            expect(payload.params).toEqual({ address: 'https://github.com/acme/app' });
            return addressResolved ? { ok: true, result: { success: true, kind: 'resolved', selector } }
                : { ok: false, errorCode: 'MACHINE_RPC_UNREACHABLE', error: 'Machine unavailable' };
        });
    });
    const inputs: DeploymentMoveToRepositoryInputV1[] = [];
    await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.environments.moveToRepository',
        machineId: checkout.machineId, installationId: 'checkout-installation', tokenEpoch: 0,
        additionalMachines: [{ machineId: detail.environment.controllerMachineId!, installationId: 'controller-installation' }],
        deploymentSource: source, requesterInvocation: 'required', execute: (raw, context) => {
            const input = DeploymentMoveToRepositoryInputV1Schema.parse(raw); inputs.push(input);
            expect(context.target.machineId).toBe(input.workspace ? checkout.machineId : detail.environment.controllerMachineId);
            if (input.useMergedVersion) return { kind: 'switched', environmentId: detail.environment.id, revision: 8, commitSha: merged.mergedCommit };
            if (input.pullRequestReference) return inputs.length === 1 ? { kind: 'pullRequestStatus', pullRequest: continuation.pullRequest }
                : { kind: 'reviewMerged', pullRequest: continuation.pullRequest, review: merged };
            if (input.mode === 'preview' && input.createRepository) return { kind: 'previewCreate', review: {
                document: definition.document, path, workspace, createRepository: input.createRepository,
                files: [{ path, before: null, content: definition.document },
                    { path: 'deploy/production-app/app.conf', before: null, content: 'version=3' }] } };
            if (input.mode === 'preview') return { kind: 'preview', review: { document: definition.document, repository,
                workspace, path, source, baseCommit: 'a'.repeat(40), baseBranch: 'main', before: 'old compose',
                files: [{ path, before: 'old compose', content: definition.document },
                    { path: 'deploy/production-app/app.conf', before: 'version=old', content: 'version=3' }] } };
            if (input.continuation) return { kind: 'reviewMerged', continuation, review: merged };
            return { kind: 'pullRequest', continuation, repository: { repository, workspace, baseCommit: 'a'.repeat(40), baseBranch: 'main' } };
        } });
    if (repositoryChoice === 'existing') {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { createUiDeploymentActionDeps } = await import('@/sync/api/deployments/deploymentActions');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const { createUiProjectAccountRowsClient } = await import('@/sync/api/projects/projectAccountRowsClient');
            const census = await createUiProjectAccountRowsClient(account).read();
            expect(census).toMatchObject({ status: 'ready', coverage: 'complete', workspaceRefs: checkoutRefs });
            const preview = await createUiDeploymentActionDeps(account).deploymentMoveToRepository!({ mode: 'preview', serverId,
                environmentId: detail.environment.id, definition: pin, path, repository, workspace,
                baseCommit: 'a'.repeat(40), baseBranch: 'main' }, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
            }, async () => ({ ok: false, errorCode: 'unexpected_child', error: 'unexpected_child' }));
            expect(preview).toMatchObject({ kind: 'preview', review: { workspace, path } });
        } finally { account.dispose(); }
        inputs.length = 0;
    }
    const controller = createDeploymentReadControllerV1({ scope, transport: {
        listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readEnvironment: async () => ({ ok: true, value: detail }), listHistory: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readReceipt: async () => ({ ok: false, failure: { code: 'not_found', retryable: false } }),
    } });
    const changed = vi.fn();
    const screen = await renderAccountScreen(<ItemList><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
        definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change: () => {} }}
        demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null}
        lifetime={lifetime} editing={{ actions: createDeploymentActions(lifetime, source.id), serverId,
            review: { pendingId: null, request() {}, open() {} }, onChanged: changed }} /></ItemList>);
    const id = 'project-deployments.environment.moveRepository';
    await screen.pressByTestIdAsync(`${id}.open`);
    if (creating) {
        await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(`${id}.createRepository`), node => node !== null); });
        await screen.pressByTestIdAsync(`${id}.createRepository`);
        // The platform modal is the boundary. Its real form stages the native input from the person's choices.
        const form: ActionInputForm = modal.spies.show.mock.calls.at(-1)![0].props?.form;
        await act(async () => { form.replaceInput({ providerKind: 'github', owner: 'acme', repositoryName: 'app', visibility: 'private' });
            await form.submit(); });
    }
    await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.root.findAllByType(ProjectSourceWorkspaceChoice)[0], node => node !== undefined); });
    if (repositoryChoice === 'existing') {
        await waitForHomeGovernance(() => expect(screen.root.findAllByType(ProjectSourceWorkspaceChoice)[0]?.props.model.status).toBe('ready'));
        expect(screen.root.findAllByType(ProjectSourceWorkspaceChoice)[0]!.props.model.candidates).toEqual([checkout]);
    }
    if (repositoryChoice === 'create-new') {
        expect(screen.findByTestId(`${id}.preview`)?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync(`${id}.chooseDestination`);
        const onResolve: (path: string, machineId: string) => void = modal.spies.show.mock.calls.at(-1)![0].props?.onResolve;
        await act(async () => onResolve(checkout.rootPath, checkout.machineId));
        await waitForHomeGovernance(() => expect(modal.spies.show.mock.calls.length, screen.getTextContent()).toBeGreaterThanOrEqual(3));
        const dialog = modal.spies.show.mock.calls.at(-1)![0] as { props: React.ComponentProps<typeof ProjectOpenScreen> };
        const chooser = await renderAccountScreen(<ProjectOpenScreen {...dialog.props} onClose={() => {}} />);
        await waitForHomeGovernance(() => expect(chooser.findByTestId('projects.open.submit')?.props.disabled, chooser.getTextContent()).toBe(false));
        await chooser.pressByTestIdAsync('projects.open.submit');
        await waitForHomeGovernance(() => expect(!screen.findByTestId(`${id}.preview`)?.props.disabled
            || chooser.findByTestId('projects.open.failed.details') !== null, chooser.getTextContent()).toBe(true));
        if (chooser.findByTestId('projects.open.failed.details')) await chooser.pressByTestIdAsync('projects.open.failed.details');
        expect(chooser.findByTestId('projects.open.failed.details') === null,
            `${chooser.getTextContent()}\nadmitted:${admitted}, issued:${homes.requestsFor('/v1/actions/projects.open').length}`).toBe(true);
        expect(screen.findByTestId(`${id}.preview`)?.props.disabled, screen.getTextContent()).toBe(false);
        await chooser.unmount();
    } else await act(async () => screen.root.findByType(ProjectSourceWorkspaceChoice).props.onChange(workspace));
    if (repositoryChoice === 'attach') {
        expect(screen.findByTestId(`${id}.preview`)?.props.disabled).toBe(true);
        await act(async () => screen.findByTestId(`${id}.repositoryAddress`)!.props.onChangeText('https://github.com/acme/app'));
        await screen.pressByTestIdAsync(`${id}.chooseRepository`);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('MACHINE_RPC_UNREACHABLE'));
        expect(screen.findByTestId(`${id}.preview`)?.props.disabled).toBe(true);
        addressResolved = true;
        await screen.pressByTestIdAsync(`${id}.chooseRepository`);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`${id}.preview`)?.props.disabled,
            `${screen.getTextContent()}\nRPC methods:${JSON.stringify(rpcMethods)}`).toBe(false));
    }
    if (repositoryChoice === 'resume') {
        await act(async () => screen.findByTestId(`${id}.pullRequestUrl`)!.props.onChangeText(continuation.pullRequest.url));
        await screen.pressByTestIdAsync(`${id}.continueExisting`);
    } else {
        await screen.pressByTestIdAsync(`${id}.preview`);
        await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(`${id}.apply`), node => node !== null); });
        expect(screen.findByTestId(`${id}.diff.deploy/production-app/app.conf`)).not.toBeNull();
        expect(screen.findByTestId(`${id}.apply`)?.props.disabled).toBe(!creating);
        if (!creating) await act(async () => screen.findByTestId(`${id}.confirmPath`)!.props.onValueChange(true));
        await screen.pressByTestIdAsync(`${id}.apply`);
    }
    await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(`${id}.continue`), node => node !== null); });
    expect(screen.getTextContent()).toContain('Move deployment');
    expect(screen.getTextContent()).toContain(continuation.pullRequest.url);
    expect(changed).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync(`${id}.continue`);
    await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(`${id}.useMerged`), node => node !== null); });
    expect(screen.findByTestId(`${id}.mergedDiff.app.conf`)).not.toBeNull();
    expect(inputs.at(-1)?.useMergedVersion).toBeUndefined();
    await screen.pressByTestIdAsync(`${id}.useMerged`);
    await act(async () => { await waitForTestEvent(screen.subscribe, () => changed.mock.calls.length, count => count === 1); });
    expect(inputs[0], JSON.stringify(inputs[0])).toMatchObject({ mode: 'preview', definition: pin, path,
        ...(creating ? { workspace: { ...workspace, serverId: serverIdentityId }, createRepository: { providerKind: 'github', owner: 'acme', repositoryName: 'app', visibility: 'private' } }
            : { repository, workspace: { ...workspace, serverId: serverIdentityId }, baseCommit: 'a'.repeat(40), baseBranch: 'main' }) });
    expect(inputs.at(-1)).toMatchObject({ mode: 'apply', definition: pin,
        ...(repositoryChoice === 'resume' ? { pullRequestReference: { url: continuation.pullRequest.url } } : { continuation }), useMergedVersion: merged });
    if (repositoryChoice === 'attach') expect(inputs[0]?.sourceRepository).toEqual(selector);
    await act(async () => controller.retire());
});
