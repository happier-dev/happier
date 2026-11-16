import { isAbsolute } from 'node:path';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createCuaNativeClient } from './nativeClient.js';
import { resolveCuaExecutable } from './nativeDependency.js';
import { CUA_ACCOUNT_NAMES } from '../ui/translations.js';

export const CLOUD_PURPOSE = 'cloud-account';
export const CUA_PURPOSE = 'cua-account';
const cuaKeys = ['CUA_HOME', 'CUA_CREDENTIAL_STORE'] as const;
function unavailable(): never { throw new Error('cua_connection_unavailable'); }
function home(value: unknown) { return typeof value === 'string' && isAbsolute(value) && !value.includes('\0') ? value : unavailable(); }

// Native basis: trycua/cua@2bce4442, cua-auth/src/lib.rs (CUA_HOME +
// CUA_CREDENTIAL_STORE=file), cua-byoc/src/{state,relay}.rs.
// BYOC's native cloud configuration and Cua login share one selected native
// home. These references select existing native setup; reads never connect or
// rewrite it.
export function connectedAccountRuntime(kind: 'cloud' | 'cua'): ConnectedAccountRuntime {
    const diagnostic = { code: 'cua_connection_unavailable', severity: 'error' as const };
    function environment(values: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
        const nativeHome = values.nativeHome;
        if (kind === 'cloud') return { CUA_HOME: home(nativeHome) };
        return nativeHome ? { CUA_HOME: home(nativeHome), CUA_CREDENTIAL_STORE: 'file' } : {};
    }
    return {
        authentication: { modes: { native: { kind: 'manual', async complete(_input, context) {
            try { home(context.configuration.values.nativeHome);
                return { status: 'connected', displayName: CUA_ACCOUNT_NAMES[kind], scopes: [] }; }
            catch { return { status: 'rejected', diagnostic }; }
        } } } },
        async status(context) {
            try { return environment(context.configuration.values).CUA_HOME ? { status: 'connected', displayName: CUA_ACCOUNT_NAMES[kind] } : { status: 'reconnectRequired' }; }
            catch { return { status: 'unavailable', diagnostic }; }
        },
        async refresh(context, options) { return this.status(context, options); },
        async revoke() { return { status: 'remoteUnsupported' }; },
        async materialize(request, context) {
            if (request.kind !== 'environment' || request.keys.some(key => !cuaKeys.includes(key as typeof cuaKeys[number]))) return unavailable();
            const env = environment(context.configuration.values);
            return { kind: 'environment', env: Object.fromEntries(Object.entries(env).filter(([key]) => request.keys.includes(key))) };
        },
    };
}

export async function remoteNative(context: PluginInvocationContext) {
    const material = await context.services.connectedAccounts.materialize(CUA_PURPOSE, { kind: 'environment', keys: cuaKeys }, { signal: context.signal });
    if (material.kind !== 'environment') return unavailable();
    const cloud = await context.services.connectedAccounts.materialize(CLOUD_PURPOSE, { kind: 'environment', keys: ['CUA_HOME'] }, { signal: context.signal });
    if (cloud.kind !== 'environment' || !cloud.env.CUA_HOME || cloud.env.CUA_HOME !== material.env.CUA_HOME
        || material.env.CUA_CREDENTIAL_STORE !== 'file') return unavailable();
    // A missing or outdated `cua` keeps its own state; anything else about the native setup is a connection fact.
    const executable = await resolveCuaExecutable(context).catch((error: unknown) => {
        throw error instanceof Error && error.message === 'cua_native_unavailable'
            ? error : new Error('cua_connection_unavailable');
    });
    return createCuaNativeClient({ exec: context.services.exec, executable,
        environment: { CUA_HOME: home(cloud.env.CUA_HOME), CUA_CREDENTIAL_STORE: 'file' } });
}
