import * as React from 'react';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalServiceLauncherSnapshotV1} from '@happier-dev/protocol/local/services/launcher/v1';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema, DaemonLocalServiceLauncherStartRequestV1Schema,
    DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePublicPreviewCreateResponseV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import type { IModal } from '@/modal/types';
import { buildLocalServiceInventoryRow, buildLocalServiceInventoryState } from '@/dev/testkit/fixtures/localServices';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { pressTestInstanceAsync, renderScreen, flushHookEffects } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

// Real Account lifetime beneath genuine network/device-credential boundaries;
// signed-out fixtures cannot dispatch through the mounted Services host.
const home = createHomeGovernanceHarness();
installDisconnectedServerSocketBoundary();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
const { ProjectRightPanelServicesView } = await import('./ProjectRightPanelServicesView');
const { ServiceRowView } = await import('@/components/sessions/localServices/ServiceRowView');
const { createFrontDoorRuntimeActionExecutor } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');

// Load the real daemon producers at runtime without rooting the CLI's compiler graph in UI tests.
const launcherProducerPath = fileURLToPath(new URL('../../../../../../cli/src/daemon/local/services/launch/suggestions.ts', import.meta.url));
const previewProducerPath = fileURLToPath(new URL('../../../../../../cli/src/daemon/local/services/preview/registry.ts', import.meta.url));
const { buildLocalServiceLauncherSnapshot } = await vi.importActual<{
    buildLocalServiceLauncherSnapshot(input: Readonly<{
        machineId: string; accountId: string; sessionId: string; updatedAt: number;
        runTargets: readonly never[];
        inventoryEntries: readonly ReturnType<typeof buildLocalServiceInventoryRow>[];
        previewResources: readonly LocalServicePreviewResourceV1[];
    }>): LocalServiceLauncherSnapshotV1;
}>(launcherProducerPath);
const { previewIdForInventoryEntry } = await vi.importActual<{
    previewIdForInventoryEntry(accountId: string, machineId: string, sessionId: string | undefined, entryId: string): string;
}>(previewProducerPath);
const publicPreviewId = previewIdForInventoryEntry('project-account', 'machine-a', 'session-a', 'project-feed');

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: navigation.push },
}).module);
// Only the daemon network is substituted; the mounted host and all Action dispatch run for real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
        spies: { confirm: modalConfirmMock, show: modalShowMock, alert: modalAlertMock },
    }).module;
});

async function publishFeatures(serverId: string, publicPreviewEnabled: boolean) {
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: 'srv_services_project' },
    }, features: {
        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
            preview: { enabled: true }, publicPreview: { enabled: publicPreviewEnabled } },
        browser: { enabled: true, viewTargets: { enabled: true } },
    } });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    // The real decision hook reads the Home's canonical published snapshot.
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features,
        serverIdentityId: features.capabilities.serverIdentity.serverIdentityId } });
    return features;
}

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        updatedAt: 3_000,
        targets: [{
            id: 'inventory:project-feed',
            source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'project-feed' },
            machineId: 'machine-a',
            title: 'Project feed service',
            subtitle: 'localhost:3000',
            confidence: 'medium',
            state: 'available',
            actions: ['start'],
        }],
    });
}

function buildPublicPreviewLauncherState() {
    const snapshot = buildLocalServiceLauncherSnapshot({
        machineId: 'machine-a',
        accountId: 'project-account',
        sessionId: 'session-a',
        updatedAt: 3_000,
        runTargets: [],
        inventoryEntries: [buildLocalServiceInventoryRow({ id: 'project-feed', port: 3000,
            provenance: { session: { id: 'session-a' } } })],
        previewResources: [{
            previewId: publicPreviewId,
            machineId: 'machine-a',
            sessionId: 'session-a',
            owner: { kind: 'session', id: 'session-a' },
            target: { scheme: 'http', host: '127.0.0.1', port: 3000 },
            initialPath: { pathname: '/', search: '' },
            display: { title: 'Project feed preview', addressLabel: 'localhost:3000' },
            originMode: 'host',
        }],
    });
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), snapshot);
}

function buildPublicPreviewState() {
    return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        generatedAt: 4_000,
        refreshState: 'idle',
        policy: {
            enabled: true,
            allowedModes: ['secret_link'],
            maxTtlMs: 600_000,
            maxConcurrentExposures: 2,
            dnsTlsRequired: true,
            auditRequired: true,
            rateLimitProfileIds: ['default'],
        },
        exposures: [],
        diagnostics: [],
    });
}

describe('ProjectRightPanelServicesView', () => {
    let serverId: string;
    let serverIdentityId: string;
    beforeEach(async () => {
        await home.reset();
        serverId = await home.addHome({ name: 'Project Home', serverUrl: 'https://project.example.test', accountId: 'project-account',
            serverIdentityId: 'srv_services_project', currentAccount: true });
        const features = await publishFeatures(serverId, true);
        if (!features.capabilities.serverIdentity.serverIdentityId) throw new Error('expected_home_identity');
        serverIdentityId = features.capabilities.serverIdentity.serverIdentityId;
        rpc.machine.mockReset();
        rpc.machine.mockImplementation(async () => { throw new Error('unexpected_machine_rpc'); });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'project-account' };
        storage.setState({ profileScope: scope, settingsScope: scope });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'], 'localServices.publicPreview.create': ['ui'] },
        } }), 1);
        modalConfirmMock.mockClear();
        navigation.push.mockClear();
        modalAlertMock.mockClear();
        modalShowMock.mockReset();
        modalShowMock.mockImplementation(() => 'modal-id');
    });
    afterEach(async () => { await home.reset(); });

    it('keeps same-name checkout descriptions separate across workspace and machine scope, retaining worker copies', async () => {
        const workspace = { serverId, machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const source = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } as const;
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(JSON.stringify({
                version: 1, services: { web: { source, execution: 'portable' } },
            })) },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            commands: [{ name: 'web', usage: 'service', source, availability: 'available', invocation: { tool: 'npm', args: ['run', 'dev'], cwd: '.' } }],
        });
        home.answer(serverId, '/v1/machines/machine-a', { body: { machine: createPlainMachineRowFixture({ id: 'machine-a', accountId: 'project-account' }) } });
        home.answer(serverId, '/v1/actions/projects.inspect', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect', requestId: request.requestId,
                execution: { ok: true, result: inspection } }) };
        } });
        rpc.machine.mockImplementation(async ({ method }) => {
            if (method === 'daemon.projects.inspect.v1') return inspection;
            throw new Error(`unexpected_rpc:${method}`);
        });
        const target = (id: string, machineId: string, workspaceRefId: string, rootPath: string) => LocalServiceLaunchTargetV1Schema.parse({
            id, source: 'managed_service', machineId, workspace: { ...workspace, machineId, workspaceId: workspaceRefId, rootPath },
            declaration: { workspaceRefId, selection: { kind: 'manifest', name: 'web' } }, title: 'web',
            confidence: 'high', state: 'available', serviceState: 'running', actions: ['manage'],
        });
        const own = target('own-web', 'machine-a', 'accepted', '/repo');
        const worker = target('worker-web', 'machine-b', 'worker-copy', '/worker');
        const foreign = { ...target('foreign-web', 'machine-a', 'other', '/other'), commandPreview: 'docker compose up web',
            declaration: { workspaceRefId: 'other', selection: { kind: 'native' as const,
                source: { kind: 'native' as const, tool: 'compose' as const, file: 'compose.yaml', target: 'web' } } } };
        const foreignManifest = { ...target('foreign-manifest-web', 'machine-a', 'third', '/third'), commandPreview: 'echo foreign' };
        const launcherSnapshotClient = vi.fn(async (input: { scope?: 'workspace' | 'machine' | null }) => ({ ok: true as const,
            snapshot: { v: 1 as const, machineId: 'machine-a', updatedAt: 1,
                targets: input.scope === 'machine' ? [own, worker, foreign, foreignManifest] : [own, worker] } }));
        const screen = await renderScreen(<ProjectRightPanelServicesView {...{ serverId }} machineId="machine-a"
            workspaceRefId="accepted" workspaceRoot="/repo" inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            launcherSnapshotClient={launcherSnapshotClient} />);
        const text = (id: string) => {
            const row = screen.findByTestId(`project-rightpanel-services-row:${id}`);
            const collect = (node: { children: readonly unknown[] }): string => node.children.map(child => typeof child === 'string'
                ? child : collect(child as { children: readonly unknown[] })).join(' ');
            return row ? collect(row) : '';
        };
        // The real row boundary carries the full command; running rows may display only its executable.
        const row = (id: string): ServiceRow | undefined => screen.findAllByType(ServiceRowView)
            .find(node => node.props.row.target.id === id)?.props.row;
        await vi.waitFor(() => expect(row('own-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' }));
        expect(text('own-web')).toContain('package.json');
        expect(row('worker-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' });
        expect(text('worker-web')).toContain('package.json');
        expect(text('foreign-web')).toBe('');
        await screen.pressByTestIdAsync('project-rightpanel-services-scope-toggle:machine');
        await vi.waitFor(() => expect(row('foreign-web')).toMatchObject({ processLabel: 'docker compose up web', sourceBadge: 'compose.yaml' }));
        expect(text('foreign-web')).toContain('compose.yaml');
        expect(text('foreign-web')).not.toContain('package.json');
        expect(row('foreign-manifest-web')).toMatchObject({ processLabel: 'echo foreign', sourceBadge: 'project.json' });
        expect(text('foreign-manifest-web')).toContain('project.json');
        expect(text('foreign-manifest-web')).not.toContain('package.json');
        expect(row('own-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' });
        expect(row('worker-web')).toMatchObject({ processLabel: 'npm run dev', sourceBadge: 'package.json' });
        await screen.unmount();
    });

    it('opens and consumes the shared approval for a declared Service Start without granting the feed launch authority', async () => {
        const workspace = { serverId, machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const target = { id: 'declared:web', source: 'managed_service' as const, machineId: workspace.machineId,
            workspace, declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest' as const, name: 'web' } },
            title: 'Web', confidence: 'high' as const, state: 'unavailable' as const, unavailableReason: 'launch_unavailable', actions: [] };
        await home.requireUiApproval(serverId, 'localServices.launcher.start');
        await installOwnMachineApprovalReplayBoundary({ harness: home, serverId, accountId: 'project-account', machineId: workspace.machineId,
            runtimeActionExecute: createDefaultRuntimeActionExecutor() });
        const running = { ...target, state: 'available' as const, serviceState: 'running' as const, actions: ['manage' as const] };
        rpc.machine.mockImplementation(async ({ method, payload }) => {
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT && payload.startReview) {
                // Native review is a read-only daemon boundary before the real approval writer.
                const request = DaemonLocalServiceLauncherStartRequestV1Schema.parse(payload.startReview.request);
                return DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse({ protocolVersion: 1,
                    snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target] },
                    startReview: { request, target: workspace, reviewedEffect: { command: 'echo web' },
                        reviewedEffectDigest: 'b'.repeat(64), setup: { required: false,
                            project: { serverId, projectId: workspace.workspaceId },
                            reviewedEffect: { commands: [] }, reviewedEffectDigest: 'a'.repeat(64) } },
                });
            }
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return DaemonLocalServiceLauncherStartResponseV1Schema.parse({
                protocolVersion: 1, machineId: workspace.machineId, targetId: target.id, status: 'succeeded',
                snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 2, targets: [running] },
            });
            throw new Error(`unexpected_rpc:${method}`);
        });
        const screen = await renderScreen(<ProjectRightPanelServicesView machineId={workspace.machineId} serverId={serverId}
            inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            launcherState={applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
                v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target],
            })} />);
        try {
            screen.pressByTestId('project-rightpanel-services-row:declared:web-start');
            await vi.waitFor(() => expect(home.artifacts(serverId).list(), JSON.stringify({
                requests: home.requests.map(({ path, input }) => ({ path, input })),
                alerts: modalAlertMock.mock.calls, machineCalls: rpc.machine.mock.calls,
            })).toHaveLength(1));
            const artifactId = home.artifacts(serverId).list()[0]!.id;
            expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining(`/inbox/approvals/${artifactId}`));
            expect(rpc.machine.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)).toHaveLength(0);
            expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject({ ok: true });
            await vi.waitFor(() => expect(rpc.machine.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)).toHaveLength(1));
            expect(modalAlertMock).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('routes a real daemon Setup refusal through the Action front door into retained preparation and its command review', async () => {
        const workspace = { serverId, machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'project-account' };
        storage.setState({ projectAccountRows: createProjectAccountRowsFixture(scope, { workspaceRefs: [
            { id: workspace.workspaceId, ...workspace, createdAtMs: 1, projectKey: 'project' },
        ] }) });
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'], 'projects.prepare': ['ui'] },
        } }), 2);
        const consent = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'a'.repeat(64),
            reviewedEffect: { v: 1, purpose: 'setup', commands: [{ kind: 'command', command: 'echo setup', cwd: '.', os: 'linux' }] } } as const;
        const held = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'service-preparation', revision: 1,
            actionId: 'projects.prepare', state: 'accepted', scope: { accountId: scope.accountId, machineId: workspace.machineId },
            title: 'Setup', createdAt: 1, cancellation: 'supported', setupReview: consent,
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId, machineId: workspace.machineId,
                workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace } });
        const target = { id: 'declared:web', source: 'managed_service' as const, machineId: workspace.machineId,
            workspace, declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest' as const, name: 'web' } },
            title: 'Web', confidence: 'high' as const, state: 'unavailable' as const, unavailableReason: 'launch_unavailable', actions: [] };
        // Finite preparation uses the captured Home's HTTP Action admission, not ambient RPC.
        const machine = ExternalActionMachineBootstrapV1Schema.parse({ id: workspace.machineId,
            kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
            installationId: 'service-machine-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            runnerContentKeyBinding: null, access: { custodian: { accountId: scope.accountId, displayName: 'Project account' },
                role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
        const machineRow = { ...createPlainMachineRowFixture({ id: machine.id, accountId: scope.accountId }),
            installationId: machine.installationId };
        home.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: machineRow } });
        home.answer(serverId, '/v1/actions/projects.prepare/execution-authorization', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-setup-root', binding: {
                accountId: scope.accountId, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
                machineId: machine.id, installationId: machine.installationId, custodianAccountId: scope.accountId,
                accountEncryptionMode: 'plain', actionId: 'projects.prepare', requestId: request.envelope.requestId,
                target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } }) };
        } });
        home.answer(serverId, '/v1/actions/projects.prepare', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.prepare',
                requestId: request.envelope.requestId, execution: { ok: true,
                    result: ProjectCommandActionOutputV1Schema.parse({ operation: held }) } }) };
        } });
        rpc.machine.mockImplementation(async ({ method }) => {
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return DaemonLocalServiceLauncherStartResponseV1Schema.parse({
                protocolVersion: 1, machineId: workspace.machineId, targetId: target.id, status: 'denied',
                reasonCode: consent.code, reviewedEffect: consent.reviewedEffect, reviewedEffectDigest: consent.reviewedEffectDigest,
                snapshot: { v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target] },
            });
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'found', operation: held };
            if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return { items: [held], nextCursor: null };
            throw new Error(`unexpected_rpc:${method}`);
        });
        const frontDoor = createFrontDoorRuntimeActionExecutor();
        const execute = Object.assign(vi.fn(frontDoor), { actionExecute: frontDoor.actionExecute });
        const screen = await renderScreen(<ProjectRightPanelServicesView machineId={workspace.machineId} serverId={serverId} runtimeActionExecute={execute}
            inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            launcherState={applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
                v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [target],
            })} />);
        await flushHookEffects();
        screen.pressByTestId('project-rightpanel-services-row:declared:web-start');
        await vi.waitFor(() => expect(screen.findByTestId('project-rightpanel-services-setup-review-approve')).toBeTruthy());
        expect(screen.getTextContent()).toContain('echo setup');
        expect(modalAlertMock).not.toHaveBeenCalled();
        const startRequest = rpc.machine.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)?.[0];
        // Submitted Start outlives the issuing view; native preparation has no shorter caller deadline.
        expect(startRequest).toMatchObject({ operationTimeoutMs: null });
        expect(startRequest?.signal).toBeUndefined();
        expect(home.requestsFor('/v1/actions/projects.prepare').map(request =>
            ExternalActionRequestEnvelopeV1Schema.parse(ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.input).envelope).input))
            .toEqual([{ workspace: { ...workspace, serverId: serverIdentityId }, phase: 'setup' }]);
        await screen.unmount();
    });

    it('passes supplied local service launcher state into the Services pane', async () => {
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('mounts one body on the Services page and the rail: only the page leads with its purpose', async () => {
        const page = await renderScreen(
            <ProjectRightPanelServicesView
                presentation="page"
                testID="project-services-page"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(page.findByTestId('project-services-page-header')).toBeTruthy();
        expect(page.getTextContent()).toContain('Long-running services for this checkout');
        expect(page.findByTestId('project-services-page-row:inventory:project-feed')).toBeTruthy();
        await page.unmount();

        const rail = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(rail.findAllByTestId('project-rightpanel-services-header')).toHaveLength(0);
        expect(rail.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('does not poll public preview status when public previews are disabled', async () => {
        await publishFeatures(serverId, false);
        const publicPreviewStatusClient = vi.fn(async () => ({
            ok: false as const,
            reason: 'unavailable' as const,
        }));

        await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                publicPreviewStatusClient={publicPreviewStatusClient}
            />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(publicPreviewStatusClient).not.toHaveBeenCalled();
    });

    it('builds a launcher start runtime action request without requiring session context', async () => {
        rpc.machine.mockResolvedValue(DaemonLocalServiceLauncherStartResponseV1Schema.parse({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'inventory:project-feed',
            status: 'succeeded',
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 4_000,
                targets: [],
            },
        }));
        const frontDoor = createFrontDoorRuntimeActionExecutor();
        const runtimeActionExecute = Object.assign(vi.fn(frontDoor), { actionExecute: frontDoor.actionExecute });
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        // Let the real asynchronous credential binding publish before user ingress.
        await flushHookEffects();
        await pressTestInstanceAsync(
            screen.findByTestId('project-rightpanel-services-row:inventory:project-feed-start'),
            'project-rightpanel-services-row:inventory:project-feed-start',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'inventory:project-feed',
            },
            context: {
                serverId,
                expectedAccountId: 'project-account',
                surface: 'ui',
            },
        });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId, machineId: 'machine-a', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            payload: { machineId: 'machine-a', targetId: 'inventory:project-feed' },
        }));
        await expect(runtimeActionExecute.mock.results[0]!.value).resolves.toMatchObject({
            protocolVersion: 1, machineId: 'machine-a', targetId: 'inventory:project-feed',
            status: 'succeeded', snapshot: { targets: [] },
        });
    });

    it('creates a public preview through the real Services Action host under the Account UI approval waiver', async () => {
        rpc.machine.mockResolvedValue(DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse({
            protocolVersion: 1,
            exposure: {
                exposureId: 'public-preview-1',
                previewId: publicPreviewId,
                sessionId: 'session-a',
                machineId: 'machine-a',
                mode: 'secret_link',
                state: 'active',
                publicUrl: 'https://preview.example.test/public-preview-1',
                issuedAt: 4_000,
                expiresAt: 604_000,
                auditEventIds: ['audit-1'],
                rateLimitProfileId: 'default',
            },
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: publicPreviewId,
                generatedAt: 4_000,
                refreshState: 'idle',
                policy: {
                    enabled: true,
                    allowedModes: ['secret_link'],
                    maxTtlMs: 600_000,
                    maxConcurrentExposures: 2,
                    dnsTlsRequired: true,
                    auditRequired: true,
                    rateLimitProfileIds: ['default'],
                },
                exposures: [],
                diagnostics: [],
            },
        }));
        const frontDoor = createFrontDoorRuntimeActionExecutor();
        const runtimeActionExecute = Object.assign(vi.fn(frontDoor), { actionExecute: frontDoor.actionExecute });
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildPublicPreviewLauncherState()}
                publicPreviewState={buildPublicPreviewState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await screen.pressByTestIdAsync('project-rightpanel-services-row:inventory:project-feed-item');
        await flushHookEffects();
        await screen.pressByTestIdAsync('project-rightpanel-services-row:inventory:project-feed-share');
        await flushHookEffects();

        expect(modalShowMock).not.toHaveBeenCalled();
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: publicPreviewId,
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
            context: {
                serverId,
                expectedAccountId: 'project-account',
                signal: expect.any(AbortSignal),
                surface: 'ui',
            },
        });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId, machineId: 'machine-a', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            payload: expect.objectContaining({ previewId: publicPreviewId, sessionId: 'session-a',
                mode: 'secret_link', ttlMs: 600_000, confirmation: { acknowledged: true } }),
        }));
        await expect(runtimeActionExecute.mock.results[0]!.value).resolves.toMatchObject({
            protocolVersion: 1, exposure: { exposureId: 'public-preview-1', previewId: publicPreviewId,
                publicUrl: 'https://preview.example.test/public-preview-1' },
        });
    });
});
