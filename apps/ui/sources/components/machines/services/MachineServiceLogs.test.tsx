import * as React from 'react';
import { createHash } from 'node:crypto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_RESOURCE_REF_V1,
    DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import type { MachineServiceRowV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildLocalServiceInventoryState } from '@/dev/testkit/fixtures/localServices';
import type { ItemRowActionsProps } from '@/components/ui/lists/ItemRowActions';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { TelemetryCaptureInvoke } from '@/components/projects/deployments/telemetryCaptureReads';
import { installHostResourceWatchSocket } from '@/components/projects/deployments/resourceWatchSocket.testFixture';
import { createTelemetryCaptureFixtureTransport, TelemetryCaptureFixtureProvider } from '@/dev/testkit/fixtures/telemetryCaptureFixtures';
import { t } from '@/text';

// The log viewport's recycler depends on native layout; render its rows deterministically at that boundary.
vi.mock('@legendapp/list/react-native', async () =>
    (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));

// Only the authenticated Home HTTP/device-credential boundary is substituted.
// The mounted Machine source, Action, Resource store and log-viewer owners stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { MachineServiceLogs } = await import('./MachineServiceLogs');
const { LocalServicesSurfaceHost } = await import('@/components/sessions/localServices/LocalServicesSurfaceHost');
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
const HOME_IDENTITY = 'srv_service_logs';
const WORKTREE = {
    machineId: 'machine', workspaceId: 'checkout', rootPath: '/repo', projectId: 'accepted-project',
};
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Service logs', serverUrl: 'https://service-logs.test',
        serverIdentityId: HOME_IDENTITY, accountId: 'account', currentAccount: true, active: true, localServicesEnabled: true });
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        body: createPlainProjectAccountRowListFixture({ workspaceRefs: [{
            id: WORKTREE.workspaceId, serverId, machineId: WORKTREE.machineId,
            rootPath: WORKTREE.rootPath, createdAtMs: 1, projectKey: WORKTREE.projectId,
        }] }),
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://service-logs.test', { serverId });
    if (!credentials) throw new Error('Service logs Home credentials unavailable');
    // Match the app entry: Sync owns encryption observation and Account admission.
    await restoreConnectionToActiveServer(credentials);
});
afterEach(async () => { await homes.reset(); standardCleanup(); });

describe('Machine service shared log viewer', () => {
    it.each([
        { code: 'secret_redaction_unavailable',
            message: 'Redeploy the Environment to restore service log secret masking',
            details: { reason: 'secret_redaction_redeploy_required', remedy: 'redeploy_environment', retryable: false },
            unavailable: true },
        { code: 'unclassified_log_failure', message: 'Log read failed', details: undefined, unavailable: false },
        { code: 'access_denied', message: 'Read refused', details: undefined, unavailable: false },
    ])('presents the typed $code refusal without inventing a Machine reachability failure', async failure => {
        const actionId = 'machines.services.logs.read';
        const actionPath = `/v1/actions/${actionId}`;
        const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-service-log-proof', binding: {
                serverIdentityId: 'srv_service_logs', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'machine' },
                machineId: 'machine', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: { v: 1, actionId, requestId: authorized.envelope.requestId,
                execution: { ok: false, errorCode: failure.code, error: failure.message, details: failure.details } } };
        } });
        const service: MachineServiceRowV1 = { serviceId: 'service', name: 'Worker', authority: 'machine',
            lifecyclePurpose: 'deployment', generation: 'generation-a', state: 'running', watchId: 'watch', watchRevision: 'watch-revision',
            capabilities: { start: false, stop: true, restart: false, logs: true, accounting: false } };
        const openEnvironment = vi.fn();
        const screen = await renderScreen(<MachineServiceLogs serverId={serverId} machineId="machine"
            machineName="Development machine" service={service} active onOpenEnvironment={openEnvironment} />);
        try {
            const cardId = failure.unavailable
                ? 'machine-service-logs-unavailable-secret_redaction_unavailable' : 'machine-service-logs-error';
            await vi.waitFor(() => expect(screen.findHostByTestId(cardId)).not.toBeNull());
            const copy = screen.getTextContent();
            expect(copy).not.toContain('didn’t answer');
            expect(copy).not.toContain('isn’t answering');
            expect(copy).not.toContain(failure.code);
            if (failure.unavailable) {
                expect(copy).toContain('Logs stay hidden');
                expect(copy).toContain('Redeploy the Environment');
                expect(copy).not.toContain('Retry');
                // The remedy's one action opens the Environment, where its Deploy and review live.
                await screen.pressByTestIdAsync('machine-service-logs-open-environment');
                expect(openEnvironment).toHaveBeenCalledTimes(1);
            } else {
                expect(screen.findHostByTestId('machine-service-logs-open-environment')).toBeNull();
            }
            if (failure.code === 'access_denied') {
                expect(copy).toContain(t('errors.permissionDenied'));
                expect(copy).not.toContain('Retry');
            }
            await screen.pressByTestIdAsync(`${cardId}-details-toggle`);
            expect(screen.getTextContent()).toContain(failure.code);
        } finally { await screen.unmount(); }
    });

    it.each([
        { label: 'only line breaks', text: '\n\n\n\n\n' },
        { label: 'only spaces', text: '   \n\t\n' },
    ])('says there is no output yet for a log of $label instead of numbering blank lines', async ({ text }) => {
        const actionId = 'machines.services.logs.read';
        const actionPath = `/v1/actions/${actionId}`;
        const page: ManagedServiceNativeLogResultV1 = { kind: 'page', page: {
            sourceRevision: 'native-source', text, nextCursor: null, truncated: false,
        } };
        const bytes = Buffer.from(JSON.stringify(page));
        const content = { contentType: 'application/json' as const, bytesBase64: bytes.toString('base64'),
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
        const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-service-log-proof', binding: {
                serverIdentityId: 'srv_service_logs', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'machine' },
                machineId: 'machine', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
            const continuation = envelope.resourceContinuation;
            if (continuation && continuation.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)
                throw new Error('Expected finite log Resource read');
            const result = continuation
                ? { ok: true, resource: continuation.params.resource, ...content } : page;
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
        } });
        const socket = installHostResourceWatchSocket({ actionId, digest: () => content.digest });
        const service: MachineServiceRowV1 = { serviceId: 'service', name: 'Worker', authority: 'machine',
            lifecyclePurpose: 'deployment', generation: 'generation-a', state: 'running', watchId: 'watch', watchRevision: 'watch-revision',
            capabilities: { start: false, stop: true, restart: false, logs: true, accounting: false } };
        const screen = await renderScreen(<MachineServiceLogs serverId={serverId} machineId="machine"
            machineName="Development machine" service={service} active />);
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-logs')).not.toBeNull());
            expect(screen.findHostByTestId('machine-service-logs-empty')).not.toBeNull();
            expect(screen.findHostByTestId('machine-service-logs-lines')).toBeNull();
        } finally { await screen.unmount(); socket.mockRestore(); }
    });

    it('leads a refused journal read to the recipe it names, on this Machine', async () => {
        const actionId = 'machines.services.logs.read';
        const actionPath = `/v1/actions/${actionId}`;
        const journalReader = { pluginId: 'happier.machine.recipes', recipeId: 'journal-reader', revision: '1' };
        const refused: ManagedServiceNativeLogResultV1 = { kind: 'unavailable', reason: 'denied', recipeRemedy: journalReader };
        const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-service-log-proof', binding: {
                serverIdentityId: 'srv_service_logs', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'machine' },
                machineId: 'machine', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: refused } } };
        } });
        const service: MachineServiceRowV1 = { serviceId: 'service', name: 'Worker', authority: 'machine',
            lifecyclePurpose: 'deployment', generation: 'generation-a', state: 'running', watchId: 'watch', watchRevision: 'watch-revision',
            capabilities: { start: false, stop: true, restart: false, logs: true, accounting: false } };
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        const screen = await renderScreen(<MachineServiceLogs serverId={serverId} machineId="machine"
            machineName="Development machine" service={service} active />);
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-logs-set-up-recipe')).not.toBeNull());
            expect(screen.getTextContent()).toMatch(/Development machine, then read the logs again/u);
            await vi.waitFor(() => expect(screen.findByTestId('machine-service-logs-set-up-recipe')?.props.disabled).not.toBe(true));
            await screen.pressByTestIdAsync('machine-service-logs-set-up-recipe');
            const pushed = vi.mocked(router.push).mock.calls.at(-1)?.[0] as { params?: { selection?: string } } | undefined;
            expect(JSON.parse(pushed?.params?.selection ?? 'null')).toMatchObject({ type: 'software', value: journalReader,
                target: { machine: { serverIdentityId: 'srv_service_logs', machineId: 'machine' } } });
        } finally { await screen.unmount(); }
    });

    it.each(['selected checkout', 'missing checkout', 'different checkout'] as const)(
        'uses Worktree OTLP demand only for the selected occurrence with an exact serving checkout (%s)',
        async (occurrenceScope) => {
            const scope = { serverId: HOME_IDENTITY, accountId: 'account' };
            const { machineId, workspaceId, rootPath, projectId } = WORKTREE;
            const workspace = { serverId, machineId, workspaceId, rootPath };
            const source = { kind: 'worktree', serverId: HOME_IDENTITY, machineId, projectId, workspaceId };
            const sourceWorkspace = occurrenceScope === 'selected checkout' ? workspace
                : occurrenceScope === 'different checkout' ? { ...workspace, rootPath: '/repo/sibling' }
                : undefined;
            const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
                v: 1, machineId: workspace.machineId, updatedAt: 1, targets: [{
                    id: 'service', source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'generation-a' },
                    machineId: workspace.machineId, workspaceId: workspace.workspaceId, cwd: workspace.rootPath,
                    ...(sourceWorkspace ? { workspace: sourceWorkspace } : {}),
                    declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'worker' } },
                    title: 'Worker', confidence: 'high', state: 'available', serviceState: 'running', actions: ['manage'],
                }],
            });
            const { pluginId, contributionId } = DATABASE_CAPTURE_RESOURCE_REF_V1;
            const projection: PluginUiProjectionModel = {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                resourcesById: { [`${pluginId}/${contributionId}`]: {
                    id: contributionId, pluginId, resourceKind: 'config', scope: 'surface',
                } },
            };
            const invoke = vi.fn<TelemetryCaptureInvoke>(async () =>
                ({ ok: true, source, coverage: { lostObservations: 0, reason: null }, enabled: true }));
            const readCapture = vi.fn<TelemetryCaptureInvoke>(async () => ({ ok: true, source, items: [] }));
            const transport = createTelemetryCaptureFixtureTransport(readCapture);
            const screen = await renderScreen(
                <TelemetryCaptureFixtureProvider invoke={invoke} transport={transport}>
                    <LocalServicesSurfaceHost machineId={workspace.machineId} serverId={serverId}
                        workspaceRoot={workspace.rootPath} workspaceRefId={workspace.workspaceId}
                        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                        launcherState={launcherState} pluginUiProjection={projection} testID="workspace-services" />
                </TelemetryCaptureFixtureProvider>,
            );
            try {
                await vi.waitFor(() => expect(screen.findByTestId('workspace-services-view:logs')).not.toBeNull());
                expect(invoke).not.toHaveBeenCalled();
                expect(readCapture).not.toHaveBeenCalled();
                expect(transport.watchers).toBe(0);
                const shownLogsAction = () => screen.findAllByType(ItemRowActions).flatMap(menu => (menu.props as ItemRowActionsProps).actions)
                    .find(action => action.id === 'show-logs');
                await vi.waitFor(() => expect(shownLogsAction()).toBeDefined());
                await act(async () => { shownLogsAction()?.onPress?.(); });
                expect(screen.findHostByTestId('workspace-services-logs')).not.toBeNull();
                if (occurrenceScope === 'selected checkout') {
                    await vi.waitFor(() => expect(readCapture).toHaveBeenCalledWith(expect.objectContaining({
                        scope, collectorMachineId: workspace.machineId, actionId: DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
                        input: expect.objectContaining({ source }),
                    })));
                    await vi.waitFor(() => expect(transport.watchers).toBe(1));
                    expect(invoke).toHaveBeenCalledTimes(1);
                    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ actionId: DATABASE_CAPTURE_STATUS_ACTION_ID_V1 }));
                    expect(readCapture).toHaveBeenCalledTimes(1);
                } else {
                    await flushHookEffects();
                    expect(invoke).not.toHaveBeenCalled();
                    expect(readCapture).not.toHaveBeenCalled();
                    expect(transport.watchers).toBe(0);
                }
            } finally { await screen.unmount(); }
        },
    );

    it.each(['machine', 'workspace'] as const)('%s logs retain admitted redacted lines through follow, pause, resume and a source change, then release hidden demand', async surface => {
        const actionId = 'machines.services.logs.read';
        const actionPath = `/v1/actions/${actionId}`;
        const first: ManagedServiceNativeLogResultV1 = { kind: 'page', page: {
            sourceRevision: 'native-source', text: 'first [REDACTED]\n', nextCursor: null, truncated: true,
        } };
        let current: ManagedServiceNativeLogResultV1 = first;
        let resourceFailure = false;
        let firstReads = 0;
        let resourceReads = 0;
        let watchOpens = 0;
        let watchCloses = 0;
        let deliver: (() => void) | undefined;
        const content = () => {
            const bytes = Buffer.from(JSON.stringify(current));
            return { contentType: 'application/json' as const, bytesBase64: bytes.toString('base64'),
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
        };
        const emit = async () => {
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            await act(async () => {
                deliver?.();
                await flushHookEffects();
            });
        };
        const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-service-log-proof', binding: {
                serverIdentityId: 'srv_service_logs', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'machine' },
                machineId: 'machine', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
            const reply = (result: unknown): HomeDomainAnswer => ({ body: {
                v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result },
            } });
            const continuation = envelope.resourceContinuation;
            if (!continuation) {
                expect(envelope.input).toMatchObject({ serviceId: 'service' });
                expect(envelope.machineServiceLogsGeneration?.expectedGeneration).toBe('generation-a');
                firstReads++;
                return reply(first);
            }
            // The mounted follower opens once on the Home socket. HTTP only serves finite snapshots.
            if (continuation.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)
                throw new Error('Expected finite log Resource read');
            resourceReads++;
            if (resourceFailure) return reply({ ok: false, code: 'service_transport_unavailable', reason: 'unavailable' });
            return reply({ ok: true, resource: continuation.params.resource, ...content() });
        } });
        const socket = installHostResourceWatchSocket({ actionId, digest: () => content().digest,
            onOpen(watch) {
                watchOpens++;
                deliver = () => watch.invalidate(resourceFailure ? `sha256:${'0'.repeat(64)}` : content().digest);
            },
            onDisconnect() { watchCloses++; deliver = undefined; },
        });
        const service: MachineServiceRowV1 = { serviceId: 'service', name: 'Worker', authority: 'machine',
            lifecyclePurpose: 'deployment', generation: 'generation-a', state: 'running', watchId: 'watch', watchRevision: 'watch-revision',
            capabilities: { start: false, stop: true, restart: false, logs: true, accounting: false } };
        const props = { serverId, machineId: 'machine', machineName: 'Development machine', service };
        const workspace = { serverId, machineId: 'machine', workspaceId: 'checkout', rootPath: '/repo' };
        const inventoryState = buildLocalServiceInventoryState({ rows: [] });
        const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1, machineId: 'machine', updatedAt: 1, targets: [{
                id: 'service', source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'generation-a' },
                machineId: 'machine', workspaceId: workspace.workspaceId, cwd: workspace.rootPath, workspace,
                declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'worker' } },
                title: 'Worker', confidence: 'high', state: 'available', serviceState: 'running', actions: ['manage'],
            }],
        });
        const render = (active: boolean) => surface === 'machine'
            ? <MachineServiceLogs {...props} active={active} />
            : <PluginSurfaceFocusEligibilityProvider active={active}>
                <LocalServicesSurfaceHost machineId="machine" serverId={serverId} workspaceRoot="/repo"
                    inventoryState={inventoryState} launcherState={launcherState} testID="workspace-services" />
              </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(render(true));
        try {
            if (surface === 'workspace') {
                await vi.waitFor(() => expect(screen.getTextContent()).toContain('Worker'));
                expect([firstReads, watchOpens]).toEqual([0, 0]);
                const shownLogsAction = () => screen.findAllByType(ItemRowActions).flatMap(menu => (menu.props as ItemRowActionsProps).actions)
                    .find(action => action.id === 'show-logs');
                await vi.waitFor(() => expect(shownLogsAction()).toBeDefined());
                await act(async () => { shownLogsAction()?.onPress?.(); });
                expect(screen.findHostByTestId('workspace-services-logs')).not.toBeNull();
            }
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('first [REDACTED]'));
            await vi.waitFor(() => expect(watchOpens).toBe(1));
            expect(firstReads).toBe(1);
            current = { kind: 'page', page: { ...first.page, text: 'first [REDACTED]\ncontinued 🌍\n' } };
            await emit();
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('continued 🌍'));
            const beforePause = resourceReads;
            await screen.pressByTestIdAsync('machine-service-logs-follow');
            await vi.waitFor(() => expect(watchCloses).toBe(1));
            // Replacing the live subscriber with a static one settles one finite snapshot.
            await vi.waitFor(() => expect(resourceReads).toBe(beforePause + 1));
            expect(screen.getTextContent()).toContain('continued 🌍');
            const paused = { resourceReads, watchOpens };
            current = { kind: 'page', page: { ...first.page, text: 'first [REDACTED]\nresumed 🌍\n' } };
            await flushHookEffects();
            expect({ resourceReads, watchOpens }).toEqual(paused);
            expect(screen.getTextContent()).not.toContain('resumed 🌍');
            await screen.pressByTestIdAsync('machine-service-logs-follow');
            await vi.waitFor(() => expect(watchOpens).toBe(2));
            await emit();
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('resumed 🌍'));
            expect(firstReads).toBe(1);
            resourceFailure = true;
            await emit();
            await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-logs-stale')).not.toBeNull());
            expect(screen.getTextContent()).toContain('resumed 🌍');
            expect(screen.getTextContent()).not.toContain('isn’t answering');
            resourceFailure = false;
            const beforeChange = resourceReads;
            current = { kind: 'source-changed', sourceRevision: 'replacement-source' };
            await emit();
            await vi.waitFor(() => expect(resourceReads).toBeGreaterThan(beforeChange));
            await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-logs-restarted')).not.toBeNull());
            // The source transition warns without erasing already-admitted redacted evidence.
            expect.soft(screen.getTextContent()).toContain('resumed 🌍');
            expect.soft(screen.getTextContent()).toContain('first [REDACTED]');
            await screen.update(render(false));
            await vi.waitFor(() => expect(watchCloses).toBe(watchOpens));
            expect(deliver).toBeUndefined();
            const hidden = { firstReads, resourceReads, watchOpens };
            await flushHookEffects();
            expect({ firstReads, resourceReads, watchOpens }).toEqual(hidden);
        } finally { await screen.unmount(); socket.mockRestore(); }
    });
});
