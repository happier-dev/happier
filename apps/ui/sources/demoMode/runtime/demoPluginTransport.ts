import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginReference } from '@happier-dev/plugin-sdk';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import {
    PluginUiExecuteActionRequestV1Schema, PluginUiJsonValueV1Schema, PluginUiPublishCurrentUiContextRequestV1Schema,
    PluginUiResourceSubscriptionTargetV1Schema, PluginUiResourceSubscriptionRequestV1Schema,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { computeSha256HexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';

import { encodeBase64 } from '@/encryption/base64';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceHostApi, type PluginSurfaceHostApiHandlers } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { getPluginUiEphemeralSharedScope } from '@/components/plugins/surfaces/pluginUiEphemeralSharedScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getDemoModeServerId, isDemoModeActive } from './enterExitDemoMode';
import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import { createPluginActionInputSelectionHostApiHandler } from '@/components/plugins/surfaces/pluginActionInputSelectionHostApi';
import { createPluginOpenNewSessionHostApiHandler } from '@/components/plugins/surfaces/pluginOpenNewSessionHostApi';
import { DEMO_MACHINE_ID } from '../world/constants';
import { createPluginPageLocationOwner } from '@/components/plugins/pages/pluginPageLocation';

/** Substitutes only daemon/Account transports for one existing demo mount. */
export function createDemoPluginTransport(input: Readonly<{
    pluginId: string;
    surface: SurfaceContext;
    readResource?: (resource: PluginReference) => unknown | Promise<unknown>;
    executeAction?: (action: PluginReference, payload: JsonValue, options?: PluginCancellationOptions) => unknown | Promise<unknown>;
}>) {
    if (!isDemoModeActive()) throw new Error('A demo plugin transport requires an active demo world.');
    const demoHome = getDemoModeServerId();
    let disposed = false;
    const retirement = new Set<() => void>();
    const controller = new AbortController();
    const isCurrent = () => !disposed && isDemoModeActive() && getDemoModeServerId() === demoHome;
    const accountLifetime: ActiveServerAccountScopeLifetime = {
        scope: { serverId: demoHome ?? 'demo-stage', accountId: 'demo-stage' },
        isCurrent,
        onRetire(cancel) {
            if (disposed) { cancel(); return { dispose() {} }; }
            retirement.add(cancel);
            return { dispose: () => { retirement.delete(cancel); } };
        },
    };
    let subPath = '';
    const pageLocation = createPluginPageLocationOwner({ currentSubPath: () => subPath,
        routePathFor: path => path, replaceLocation: path => { subPath = path; }, isCurrent,
        allowPreservingReplacement: true });
    const requestSurface = {
        pluginId: input.pluginId, contributionId: 'demo-stage', surfaceId: `demo-stage-${input.pluginId}`,
        placement: 'appSurface', platform: input.surface.platform, channel: 'internal', resourceScope: [], diagnostics: [],
    } satisfies PluginUiSurfaceContextV1;
    const handlers: PluginSurfaceHostApiHandlers = {
        replacePageLocation: pageLocation.handleReplaceRequest,
        diagnostic(request) {
            logPluginSurfaceDiagnostic(requestSurface, request.payload);
            return null;
        },
        publishCurrentUiContext(request) {
            // The stage has no ambient-agent consumer. Admit the real publication grammar;
            // the authored surface still owns its current context and mounted commands.
            PluginUiPublishCurrentUiContextRequestV1Schema.parse(request.payload);
            return null;
        },
    };
    handlers.selectActionInput = createPluginActionInputSelectionHostApiHandler({
        host: { machineId: DEMO_MACHINE_ID, serverId: accountLifetime.scope.serverId,
            targetPluginId: input.pluginId, accountLifetime, signal: controller.signal, isCurrent },
        isCurrent,
    });
    if (input.readResource) {
        const readResource = input.readResource;
        handlers.readResource = async request => {
            const payload = request.payload;
            const resource = PluginUiResourceSubscriptionTargetV1Schema.parse(
                payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload.resource : undefined,
            );
            if (typeof resource === 'string' || !('localId' in resource)) throw new Error('Demo resources require a qualified reference.');
            const bytes = new TextEncoder().encode(JSON.stringify(PluginUiJsonValueV1Schema.parse(await readResource(resource))));
            return { contentType: 'application/json', digest: `sha256:${computeSha256HexDigest(bytes)}`, bytesBase64: encodeBase64(bytes) };
        };
        handlers.watchResource = request => {
            PluginUiResourceSubscriptionRequestV1Schema.parse(request.payload);
            // Fixture resources are immutable for this mount. The physical adapter owns subscription disposal.
            return {};
        };
        handlers.disposeHostResource = () => ({});
    }
    if (input.executeAction) {
        const executeAction = input.executeAction;
        handlers.executeAction = async (request, options) => {
            const payload = PluginUiExecuteActionRequestV1Schema.parse(request.payload);
            return PluginUiJsonValueV1Schema.parse(await executeAction(payload.action, payload.input, options));
        };
        handlers.openNewSession = createPluginOpenNewSessionHostApiHandler({
            pluginId: input.pluginId, accountLifetime, lifetimeSignal: controller.signal, isCurrent,
            executionTarget: { serverId: accountLifetime.scope.serverId, machineId: DEMO_MACHINE_ID },
            executeSelectedOperation: handlers.executeAction,
        });
    }
    const owner = createPluginSurfaceHostApi({ surfaceContext: requestSurface, handlers });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface: input.surface, requestSurface,
        handleRequest: owner.handleRequest, installedMethods: owner.installedMethods, isCurrent });
    const ephemeralSharedScope = getPluginUiEphemeralSharedScope({ accountLifetime, pluginId: input.pluginId,
        occurrenceId: `demo-stage-${input.pluginId}`, isCurrent });
    return {
        ...adapter,
        accountLifetime, ephemeralSharedScope, signal: controller.signal,
        pageLocation: { subscribe: pageLocation.subscribe, readSubPath: () => subPath },
        dispose() {
            if (disposed) return;
            disposed = true;
            controller.abort();
            pageLocation.dispose();
            adapter.dispose();
            for (const retire of retirement) retire();
            retirement.clear();
        },
    };
}
