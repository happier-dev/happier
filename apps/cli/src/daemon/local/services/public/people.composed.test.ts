import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ActionExecutorContext, ActionExecutorDeps, RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { LocalServicePublicExposureAudienceV1 } from '@happier-dev/protocol/local/services/public/v1';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createActionExecutorBoundaryFixture } from '../../../../../../../packages/tests/src/testkit/actionExecutorBoundary';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { createLocalServicePublicPreviewServerRoutes } from './routes';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { LocalServicePublicPreviewCreateClientInput, LocalServicePublicPreviewCreateClientResult } from '../../../../../../../apps/ui/sources/sync/domains/local/services/publicPreview/api';

const machineTransport = vi.hoisted(() => vi.fn());
// Only the cross-process Machine RPC transport is replaced. The registered
// daemon handler, request schemas, Action admission and HTTP adapter remain real.
vi.mock('../../../../../../../apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineTransport,
}));
// The canonical native SDK boundary used by the UI's own Node suites.
vi.mock('@react-native-masked-view/masked-view', async () => import('../../../../../../../apps/ui/sources/dev/reactNativeMaskedViewStub'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('../../../../../../../apps/ui/sources/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
    const { createExpoUpdatesMock } = await import('../../../../../../../apps/ui/sources/dev/testkit/mocks/expoUpdates');
    return createExpoUpdatesMock();
});
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('../../../../../../../apps/ui/sources/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock().module;
});
vi.mock('react-native-typography', async () => {
    const { createReactNativeTypographyMock } = await import('../../../../../../../apps/ui/sources/dev/testkit/mocks/reactNativeTypography');
    return createReactNativeTypographyMock();
});
vi.mock('@shopify/react-native-skia', async () => {
    const { createReactNativeSkiaMock } = await import('../../../../../../../apps/ui/sources/dev/testkit/mocks/reactNativeSkia');
    return createReactNativeSkiaMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('../../../../../../../apps/ui/sources/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

// App-local aliases belong to each app's compiler. The existing cross-app Vitest
// resolver loads these real UI owners without adding UI aliases to the CLI TS program.
async function uiOwner<T>(path: string): Promise<T> {
    return await import(new URL(`../../../../../../../apps/ui/sources/${path}`, import.meta.url).href) as T;
}
type ExecuteAction = (id: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<unknown>;
type FrontDoor = (args: Parameters<RuntimeActionExecute>[0]) => Promise<unknown>;

interface PeopleServer {
    ownerAccountId: string;
    preview: LocalServicePreviewResourceV1;
    audience: LocalServicePublicExposureAudienceV1;
    ineligibleAudience: LocalServicePublicExposureAudienceV1;
    post(path: string, body: unknown): Promise<{ status: number; data: unknown }>;
    close(): Promise<void>;
}
let server: PeopleServer;
let disposeEditorLoader: (() => void) | undefined;
beforeAll(async () => {
    const modulePath = '../../../../../../../apps/server/sources/testkit/localServicePublicPeopleServer.testkit.ts';
    const owner = await import(modulePath) as { createLocalServicePublicPeopleServer(): Promise<PeopleServer> };
    server = await owner.createLocalServicePublicPeopleServer();
    const shim = await uiOwner<{ installVitestRnShim(): void;
        loadVitestModuleForNodeRequire(moduleUrl: URL, load: () => Promise<unknown>): Promise<{ dispose(): void }> }>('dev/vitestRnShim.ts');
    shim.installVitestRnShim();
    const editorUrl = new URL('../../../../../../../apps/ui/sources/components/ui/code/editor/CodeEditor.native.tsx', import.meta.url);
    const editor = await shim.loadVitestModuleForNodeRequire(editorUrl, () => import(editorUrl.href));
    disposeEditorLoader = editor.dispose;
}, 180_000);
afterAll(async () => { disposeEditorLoader?.(); await server?.close(); });
afterEach(() => machineTransport.mockReset());

it.each(['created', 'audience_not_eligible'] as const)(
    'carries the Specific people audience from the UI Action through daemon HTTP (%s)', async outcome => {
        const audience = outcome === 'created' ? server.audience : server.ineligibleAudience;
        const target = { kind: 'localServicePreview', targetId: server.preview.previewId,
            machineId: server.preview.machineId, sessionId: server.preview.sessionId } satisfies Extract<BrowserViewTargetV1, { kind: 'localServicePreview' }>;
        const httpRequests: unknown[] = [];
        const routes = createLocalServicePublicPreviewServerRoutes({ token: 'fixture-token', serverBaseUrl: 'https://home.example.test', http: {
            async post(url, body) {
                if (!url.endsWith('/status')) httpRequests.push(body);
                // Bridge only the HTTP transport to the registered Fastify route.
                // Real auth, strict reader, Session access, audience eligibility,
                // exposure runtime and SQLite decide the complete server outcome.
                const reply = await server.post(new URL(url).pathname, body);
                if (reply.status >= 400) throw { isAxiosError: true, response: reply };
                return { data: reply.data };
            },
            async delete() { throw new Error('Unexpected revoke'); },
        } });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) {
            handlers.set(method, handler as RpcHandler<unknown, unknown>);
        } };
        registerDaemonLocalServicesMachineRpcHandlers(registrar, { localServicesPublicPreview: routes });
        machineTransport.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
            const handler = handlers.get(method);
            if (!handler) throw new Error(`Missing registered daemon handler: ${method}`);
            return handler(JSON.parse(JSON.stringify(payload)), { signal: new AbortController().signal });
        });

        const features = await uiOwner<{ createRootLayoutFeaturesResponse(input: unknown): FeaturesResponse }>('dev/testkit/fixtures/featureFixtures.ts');
        const discovery = await uiOwner<{
            primeServerFeaturesSnapshot(input: { serverId: string; snapshot: { status: 'ready'; features: FeaturesResponse } }): void;
            resetServerFeaturesClientForTests(): void;
        }>('sync/api/capabilities/serverFeaturesClient.ts');
        discovery.primeServerFeaturesSnapshot({ serverId: 'home_1', snapshot: { status: 'ready',
            features: features.createRootLayoutFeaturesResponse({ features: { localServices: { publicPreview: { enabled: true } } } }) } });
        try {
            type CreateExposure = (input: LocalServicePublicPreviewCreateClientInput) => Promise<LocalServicePublicPreviewCreateClientResult>;
            const publicClient = await uiOwner<{ createLocalServicePublicPreviewExposureViaMachineRpc: CreateExposure }>(
                'sync/domains/local/services/publicPreview/machineRpc.ts');
            const runtime = await uiOwner<{ createLocalServicesRuntimeActionExecutor(input: { createPublicPreviewExposure: CreateExposure }): RuntimeActionExecute }>(
                'sync/domains/local/services/actions/runtimeActionExecutor.ts');
            const boundary = await uiOwner<{ createUiActionExecutorBoundary(deps: ActionExecutorDeps, accountId: string,
                settings: ActionExecutorContext['actionsSettings']): { executeConfirmed: ExecuteAction } }>('dev/testkit/fixtures/actionExecutorBoundary.ts');
            const executor = boundary.createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
                runtimeActionExecute: runtime.createLocalServicesRuntimeActionExecutor({
                    createPublicPreviewExposure: publicClient.createLocalServicePublicPreviewExposureViaMachineRpc,
                }),
            }), server.ownerAccountId, normalizeActionsSettingsV1({ v: 1, actions: {},
                approvalWaivedSurfaces: { 'localServices.publicPreview.create': ['ui'] } }));
            const frontDoor = await uiOwner<{ createFrontDoorRuntimeActionExecutor(input: { execute: ExecuteAction }): FrontDoor }>(
                'sync/ops/actions/frontDoorRuntimeActionExecutor.ts');
            const owner = await uiOwner<{ createLocalServicePublicPreviewActions(input: {
                runtimeActionExecute: FrontDoor; serverId: string; expectedAccountId: string; copyToClipboard: () => Promise<boolean>;
            }): { create(browserTarget: typeof target, options: { mode: 'people'; ttlMs: number; audience: LocalServicePublicExposureAudienceV1 }): Promise<unknown> } }>(
                'components/sessions/localServices/publicPreviewActions.ts');
            const actions = owner.createLocalServicePublicPreviewActions({
                runtimeActionExecute: frontDoor.createFrontDoorRuntimeActionExecutor({ execute: executor.executeConfirmed }),
                serverId: 'home_1', expectedAccountId: server.ownerAccountId, copyToClipboard: async () => false,
            });
            const result = await actions.create(target, { mode: 'people', ttlMs: 600_000, audience });
            expect(httpRequests, 'the UI must reach the real daemon HTTP adapter').toHaveLength(1);
            expect(httpRequests[0], 'the server receives every selected principal').toMatchObject({ audience, sessionId: server.preview.sessionId,
                mode: 'people', confirmation: { acknowledged: true } });
            if (outcome === 'created') expect(result).toMatchObject({ exposure: { mode: 'people', audience },
                snapshot: { exposures: [{ mode: 'people', audience }] } });
            else {
                expect(result).toMatchObject({ ok: false, details: { reasonCode: 'audience_not_eligible' } });
                const presentation = await uiOwner<{
                    readLocalServiceActionOutcome(value: unknown): { kind: string; reasonCode?: string | null };
                    describeLocalServiceActionFailure(input: { reasonCode: string | null }): { body: string; details: readonly string[] };
                }>('components/sessions/localServices/localServiceActionOutcome.ts');
                const failure = presentation.readLocalServiceActionOutcome(result);
                expect(failure).toMatchObject({ kind: 'failed', reasonCode: 'audience_not_eligible' });
                const copy = presentation.describeLocalServiceActionFailure({ reasonCode: failure.reasonCode ?? null });
                expect(copy.details).toContain('audience_not_eligible');
                expect(copy.body).not.toBe(presentation.describeLocalServiceActionFailure({ reasonCode: 'request_failed' }).body);
            }
        } finally { discovery.resetServerFeaturesClientForTests(); }
    },
);
