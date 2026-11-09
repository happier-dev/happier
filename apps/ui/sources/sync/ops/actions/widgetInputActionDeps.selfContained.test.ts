import { expect, it } from 'vitest';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import type { WidgetDefinitionV1 } from '@happier-dev/protocol/widgets';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createWidgetInputActionDepsV1 } = await import('./widgetInputActionDeps');

it.each(['home', 'sessionBoard'] as const)('admits self-contained saved HTML on %s without a Machine registry', async owner => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let runtimeReads = 0;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://self-contained-widget.test', accountId: 'viewer', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.startsWith('/v2/sessions/board') || path.startsWith('/v1/machines')) runtimeReads++;
        return http.request(url, init);
    } });
    const previous = storage.getState();
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        storage.setState({ machines: {}, sessions: {} });
        const definition: WidgetDefinitionV1 = { v: 1, id: 'self-contained', name: 'Local HTML',
            body: { kind: 'html', source: artifactHtmlBundleFromBodyV1('<main>Local content</main>'), requestedCapabilities: { network: 'none', networkOrigins: [] } },
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
            inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } };
        const deps = createWidgetInputActionDepsV1(account, createActionExecutorBoundaryFixture({ widgetAccountScope: () => account }));
        const surface = { serverId: account.serverId, accountId: account.accountId,
            owner: owner === 'home' ? { kind: 'home' as const } : { kind: 'sessionBoard' as const, sessionId: 'board' } };
        runtimeReads = 0;
        const resolved = await deps.widgetInputs!.resolve({ ref: { surface, instanceId: 'local' },
            instance: { v: 1, id: 'local', definition: { kind: 'inline', definition }, bindings: {} },
            context: { surface: 'ui', authority: 'present_user' } });
        expect(resolved).toEqual({ status: 'ready', input: {} });
        expect(runtimeReads).toBe(0);
    } finally { account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});
