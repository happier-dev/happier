import { isAbsolute } from 'node:path';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationModeRuntime, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createCuaNativeClient, type CuaNativeClient } from './nativeClient.js';
import { NativeFleetClaimSchema, FleetNativeIdSchema } from './remoteSchemas.js';

export const CLOUD_PURPOSE = 'cloud-account';
export const CUA_PURPOSE = 'cua-account';
const cuaKeys = ['CUA_HOME', 'CUA_CREDENTIAL_STORE', 'CUA_FLEET_BASE_URL', 'FLEETS_TOKEN'] as const;
function unavailable(): never { throw new Error('cua_connection_unavailable'); }
function home(value: unknown) { return typeof value === 'string' && isAbsolute(value) && !value.includes('\0') ? value : unavailable(); }
function endpoint(value: unknown) {
    if (typeof value !== 'string') return unavailable();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return unavailable();
    return url.href.replace(/\/$/u, '');
}

// Native basis: trycua/cua@2bce4442, cua-auth/src/lib.rs (CUA_HOME +
// CUA_CREDENTIAL_STORE=file), cua-byoc/src/{state,relay}.rs, cua-fleet/config.rs.
// BYOC's native cloud configuration and Cua login share one selected native
// home. These references select existing native setup; reads never connect or
// rewrite it. Fleet uses the captured bearer with the selected gateway instead.
export function connectedAccountRuntime(kind: 'cloud' | 'cua'): ConnectedAccountRuntime {
    const diagnostic = { code: 'cua_connection_unavailable', severity: 'error' as const };
    function environment(values: Readonly<Record<string, unknown>>, token: string | null) {
        const nativeHome = values.nativeHome;
        if (kind === 'cloud') return { CUA_HOME: home(nativeHome) };
        return { ...(nativeHome ? { CUA_HOME: home(nativeHome), CUA_CREDENTIAL_STORE: 'file' } : {}),
            ...(values.endpoint ? { CUA_FLEET_BASE_URL: endpoint(values.endpoint) } : {}),
            ...(token ? { FLEETS_TOKEN: token } : {}) };
    }
    return {
        authentication: { modes: { native: { kind: 'manual', async complete(_input, context) {
            try { home(context.configuration.values.nativeHome);
                return { status: 'connected', displayName: kind === 'cloud' ? 'Cua native cloud account' : 'Cua native login', scopes: [] }; }
            catch { return { status: 'rejected', diagnostic }; }
        } }, ...(kind === 'cua' ? { token: { kind: 'manual' as const, async complete(input, context) {
            try {
                endpoint(context.configuration.values.endpoint);
                const token = input.fields.token;
                if (!token || /\s/u.test(token)) return { status: 'rejected' as const, diagnostic };
                await context.attemptCredentials.set('token', token);
                return { status: 'connected' as const, displayName: 'Cua Fleet', scopes: [] };
            } catch { return { status: 'rejected' as const, diagnostic }; }
        } } satisfies Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'manual' }> } : {}) } },
        async status(context) {
            try { const env = environment(context.configuration.values, await context.credentials.get('token'));
                return env.CUA_HOME || ('FLEETS_TOKEN' in env && env.FLEETS_TOKEN && 'CUA_FLEET_BASE_URL' in env && env.CUA_FLEET_BASE_URL)
                    ? { status: 'connected', displayName: 'Cua' } : { status: 'reconnectRequired' }; }
            catch { return { status: 'unavailable', diagnostic }; }
        },
        async refresh(context, options) { return this.status(context, options); },
        async revoke() { return { status: 'remoteUnsupported' }; },
        async materialize(request, context) {
            const env = environment(context.configuration.values, await context.credentials.get('token'));
            if (request.kind === 'environment') {
                if (request.keys.some(key => !cuaKeys.includes(key as typeof cuaKeys[number]))) return unavailable();
                return { kind: 'environment', env: Object.fromEntries(Object.entries(env).filter(([key]) => request.keys.includes(key))) };
            }
            if (request.kind === 'httpHeaders' && kind === 'cua' && 'CUA_FLEET_BASE_URL' in env && typeof env.CUA_FLEET_BASE_URL === 'string'
                && new URL(env.CUA_FLEET_BASE_URL).origin === request.origin && 'FLEETS_TOKEN' in env && env.FLEETS_TOKEN
                && request.headerNames.every(name => name.toLowerCase() === 'authorization')) {
                return { kind: 'httpHeaders', headers: { authorization: `Bearer ${env.FLEETS_TOKEN}` } };
            }
            return unavailable();
        },
    };
}

export async function remoteNative(context: PluginInvocationContext, id: 'byoc' | 'fleet', guestToken?: string) {
    const material = await context.services.connectedAccounts.materialize(CUA_PURPOSE, { kind: 'environment', keys: cuaKeys }, { signal: context.signal });
    if (material.kind !== 'environment') return unavailable();
    if (id === 'byoc') {
        const cloud = await context.services.connectedAccounts.materialize(CLOUD_PURPOSE, { kind: 'environment', keys: ['CUA_HOME'] }, { signal: context.signal });
        if (cloud.kind !== 'environment' || !cloud.env.CUA_HOME || cloud.env.CUA_HOME !== material.env.CUA_HOME
            || material.env.CUA_CREDENTIAL_STORE !== 'file') return unavailable();
        const status = await context.services.managedServices.dependencies.status('cua-cli', { signal: context.signal });
        if ((status.state !== 'ready' && status.state !== 'updateAvailable') || !status.executable) return unavailable();
        return createCuaNativeClient({ exec: context.services.exec, executable: status.executable,
            environment: { CUA_HOME: home(cloud.env.CUA_HOME), CUA_CREDENTIAL_STORE: 'file' } });
    }
    const origin = endpoint(material.env.CUA_FLEET_BASE_URL);
    const headers = await context.services.connectedAccounts.materialize(CUA_PURPOSE, {
        kind: 'httpHeaders', origin: new URL(origin).origin, headerNames: ['authorization'],
    }, { signal: context.signal });
    if (headers.kind !== 'httpHeaders') return unavailable();
    const native: CuaNativeClient = createCuaNativeClient({ exec: context.services.exec,
        // Fleet never invokes the CLI; it uses the native non-renewing API.
        executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.cua', localId: 'cua-cli' } },
        fleet: { http: context.services.http, origin, headers: headers.headers,
            async guest(target, signal) {
                if (!guestToken) return undefined;
                const response = await native.fleetJson({ method: 'GET', path: `api/k8s/apis/osgym.cua.ai/v1alpha1/namespaces/${target.namespace}/osgymsandboxclaims/${target.claimId}` }, signal);
                const claim = response.kind === 'success' && response.value.status === 200 ? NativeFleetClaimSchema.safeParse(response.value.value) : undefined;
                const sandbox = claim?.success ? claim.data.status?.sandbox?.name : undefined;
                if (!claim?.success || claim.data.metadata.name !== target.claimId || claim.data.metadata.namespace !== target.namespace
                    || claim.data.spec.secretRef?.name !== `cua-claim-${target.claimId}`
                    || claim.data.status?.phase !== 'Bound' || !sandbox || !FleetNativeIdSchema.safeParse(`${sandbox}-env`).success) return undefined;
                return { path: `api/svc/${target.namespace}/${sandbox}-env`, headers: { 'x-cua-env-authorization': `Bearer ${guestToken}` } };
            } },
    });
    return native;
}
