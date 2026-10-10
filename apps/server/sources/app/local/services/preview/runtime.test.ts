import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";
import { createLocalServicePreviewRuntime } from "./runtime";
import { localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';

type PreviewRuntimeModule = typeof import("./runtime");

async function loadPreviewRuntimeModule(): Promise<PreviewRuntimeModule | null> {
    return import("./runtime.js").catch(() => null) as Promise<PreviewRuntimeModule | null>;
}

const resource: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: 5173 },
    initialPath: { pathname: "/dashboard", search: "?tab=preview" },
    display: {
        title: "Vite App",
        addressLabel: "127.0.0.1:5173",
    },
    originMode: "host",
    policy: {
        allowedMethods: ["GET", "HEAD"],
        cookiePolicy: "drop",
        compressionPolicy: "identity",
        redirectPolicy: "preserve_host_origin",
        maxRequestBodyBytes: 1024 * 1024,
        maxResponseBodyBytes: 1024 * 1024,
    },
};

const hostResource: LocalServicePreviewResourceV1 = {
    ...resource,
    previewId: "alpha-beta",
    originMode: "host",
};

const nativeGrantEnv = { HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home', HANDY_MASTER_SECRET: 'registration-lifetime-test-secret' };

function mintNativeGrant(runtime: ReturnType<typeof createLocalServicePreviewRuntime>): string {
    const result = runtime.mintNativeDirectAccess({ previewId: resource.previewId,
        target: { endpointId: 'b'.repeat(64), revision: 1 },
        request: { v: 1, initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, ephemeralPublicKeyBase64Url: 'c'.repeat(43) } });
    if (!result.ok) throw new Error(result.reasonCode);
    return result.access.grant.payload.grantId;
}

describe("local service preview runtime", () => {
    it('keeps native disclosure bound to each admitted viewer and retires all viewers on starter loss', () => {
        const native = { ...resource, sessionId: undefined, owner: { kind: 'user' as const, id: 'starter_1' },
            serviceTarget: { kind: 'managed_service' as const, managedServiceId: 'instance_1', machineId: resource.machineId, cwd: '/workspace/app',
                declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } } };
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test',
            hostOriginBaseDomain: null, env: nativeGrantEnv });
        expect(runtime.registerPreview({ resource: native, accountId: 'starter_1' }).ok).toBe(true);
        const mint = (actorAccountId: string) => {
            const result = runtime.mintNativeDirectAccess({ previewId: native.previewId, actorAccountId,
                target: { endpointId: 'b'.repeat(64), revision: 1 }, request: { v: 1,
                    initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, ephemeralPublicKeyBase64Url: 'c'.repeat(43) } });
            if (!result.ok) throw new Error(result.reasonCode);
            expect(result.access.grant.payload.accountId).toBe(actorAccountId);
            const lease = runtime.openNativeRegistration(localServicePreviewDirectBindingV1(native), result.access.grant.payload.grantId);
            if (!lease.ok) throw new Error(lease.reasonCode);
            return lease;
        };
        const first = mint('viewer_1');
        const second = mint('viewer_2');
        runtime.retireMachineAccess({ machineId: 'other', accountId: 'viewer_1' });
        expect(first.signal.aborted).toBe(false);
        runtime.retireMachineAccess({ machineId: native.machineId, accountId: 'viewer_1' });
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(false);
        runtime.retireMachineAccess({ machineId: native.machineId, accountId: 'starter_1' });
        expect(second.signal.aborted).toBe(true);
        expect(runtime.resolvePreview(native.previewId)).toBeNull();
    });
    it('refuses rebinding an admitted preview identity to a different actual service occurrence', () => {
        const native = { ...resource, sessionId: undefined, owner: { kind: 'user' as const, id: 'starter_1' },
            serviceTarget: { kind: 'managed_service' as const, managedServiceId: 'instance_1', machineId: resource.machineId, cwd: '/workspace/app',
                declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } } };
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: null });
        expect(runtime.registerPreview({ resource: native, accountId: 'starter_1' }).ok).toBe(true);
        expect(runtime.registerPreview({ resource: { ...native, serviceTarget: { ...native.serviceTarget, managedServiceId: 'other_instance' } },
            accountId: 'starter_1' })).toEqual({ ok: false, reasonCode: 'invalid_preview_resource' });
        expect(runtime.resolvePreview(native.previewId)?.serviceTarget).toEqual(native.serviceTarget);
    });
    it('does not revive unused native grants when an identical preview is registered again', () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: null,
            env: nativeGrantEnv });
        const binding = localServicePreviewDirectBindingV1(resource);
        const mint = () => {
            const result = runtime.mintNativeDirectAccess({ previewId: resource.previewId,
                target: { endpointId: 'b'.repeat(64), revision: 1 },
                request: { v: 1, initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, ephemeralPublicKeyBase64Url: 'c'.repeat(43) } });
            if (!result.ok) throw new Error(result.reasonCode);
            return result.access.grant.payload.grantId;
        };
        expect(runtime.registerPreview({ resource, accountId: 'account_1' }).ok).toBe(true);
        const oldGrant = mint();
        expect(runtime.unregisterPreview(resource.previewId).ok).toBe(true);
        expect(runtime.registerPreview({ resource, accountId: 'account_1' }).ok).toBe(true);
        expect(runtime.openNativeRegistration(binding, oldGrant).ok).toBe(false);
        const freshGrant = mint();
        const current = runtime.openNativeRegistration(binding, freshGrant);
        expect(current.ok).toBe(true);
        if (!current.ok) throw new Error(current.reasonCode);
        expect(runtime.openNativeRegistration(binding, freshGrant).ok).toBe(false);
        current.close();
        expect(runtime.openNativeRegistration(binding, freshGrant).ok).toBe(false);
    });
    it('closes native viewers when the registration owner shuts down', () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: null, env: nativeGrantEnv });
        const registered = runtime.registerPreview({ resource, accountId: 'account_1' });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const first = runtime.openNativeRegistration(localServicePreviewDirectBindingV1(registered.resource), mintNativeGrant(runtime));
        const second = runtime.openNativeRegistration(localServicePreviewDirectBindingV1(registered.resource), mintNativeGrant(runtime));
        if (!first.ok || !second.ok) throw new Error('registration refused');
        first.close();
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(false);
        const owner = runtime as typeof runtime & { closeNativeRegistrations?: () => void };
        expect(owner.closeNativeRegistrations).toBeTypeOf('function');
        owner.closeNativeRegistrations!();
        expect(second.signal.aborted).toBe(true);
    });
    it('invalidates only authority-bearing native registration changes and unregistration', () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: null, env: nativeGrantEnv });
        runtime.registerPreview({ resource, accountId: 'account_1' });
        const binding = localServicePreviewDirectBindingV1(resource);
        const grantId = mintNativeGrant(runtime);
        const lease = runtime.openNativeRegistration(binding, grantId);
        if (!lease.ok) throw new Error(lease.reasonCode);
        runtime.registerPreview({ resource: { ...resource, initialPath: { pathname: '/new', search: '' } }, accountId: 'account_1' });
        expect(lease.signal.aborted).toBe(false);
        const changed = { ...resource, policy: { ...resource.policy!, allowedMethods: ['GET' as const] } };
        runtime.registerPreview({ resource: changed, accountId: 'account_1' });
        expect(lease.signal.aborted).toBe(true);
        expect(runtime.openNativeRegistration(binding, grantId).ok).toBe(false);
        const nextGrantId = mintNativeGrant(runtime);
        const next = runtime.openNativeRegistration(localServicePreviewDirectBindingV1(changed), nextGrantId);
        if (!next.ok) throw new Error(next.reasonCode);
        runtime.unregisterPreview(resource.previewId);
        expect(next.signal.aborted).toBe(true);
        expect(runtime.openNativeRegistration(localServicePreviewDirectBindingV1(changed), nextGrantId).ok).toBe(false);
    });
    it('projects credential-free native preview access when isolated DNS is unavailable', () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: null });
        const registered = runtime.registerPreview({ resource, accountId: 'account_1', nativeDirectSupported: true });
        expect(registered).toMatchObject({
            ok: true, accessUrl: null,
            nativeDirect: { v: 1, kind: 'iroh_preview', previewId: resource.previewId, machineId: resource.machineId },
        });
        expect(JSON.stringify(registered)).not.toContain('ephemeralPublicKeyBase64Url');
    });
    it('keeps exchanged viewer sessions until unregistration while URL admissions expire', () => {
        let now = 1_000;
        let serial = 0;
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: 'preview.happier.test', tokenTtlMs: 60_000, nowMs: () => now, generateRawToken: () => `admission-${++serial}` });
        const binding = { previewId: resource.previewId, sessionId: resource.sessionId, machineId: resource.machineId };
        const first = runtime.registerPreview({ resource, accountId: 'account_1' });
        const unused = runtime.registerPreview({ resource, accountId: 'account_1' });
        expect(first.ok && unused.ok).toBe(true);
        if (!first.ok || !unused.ok) return;
        const viewer = runtime.exchangeAccessToken({ ...binding, rawToken: new URL(first.accessUrl ?? '').searchParams.get('previewToken') });
        expect(viewer.ok).toBe(true);
        if (!viewer.ok) return;
        now = 61_001;
        expect(runtime.validateAccess({ ...binding, rawToken: viewer.rawToken })).toEqual({ ok: true });
        expect(runtime.exchangeAccessToken({ ...binding, rawToken: new URL(unused.accessUrl ?? '').searchParams.get('previewToken') })).toEqual({ ok: false, reasonCode: 'expired' });
        // A new admission must not prune an established viewer session.
        expect(runtime.registerPreview({ resource, accountId: 'account_1' }).ok).toBe(true);
        expect(runtime.validateAccess({ ...binding, rawToken: viewer.rawToken })).toEqual({ ok: true });
        runtime.unregisterPreview(resource.previewId);
        expect(runtime.validateAccess({ ...binding, rawToken: viewer.rawToken })).toEqual({ ok: false, reasonCode: 'preview_not_found' });
    });
    it('retains the scoped resource with a typed no-private-route result when no isolated origin exists', () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: null });
        expect(runtime.registerPreview({ resource, accountId: 'account_1' })).toEqual({
            ok: true, resource, accessUrl: null, expiresAt: null,
            accessUnavailableReasonCode: 'preview_private_route_unavailable',
        });
        expect(runtime.resolvePreviewContext(resource.previewId)).toEqual({ resource, accountId: 'account_1' });
        expect(runtime.validateAccess({ previewId: resource.previewId, rawToken: 'not-issued', sessionId: resource.sessionId, machineId: resource.machineId }).ok).toBe(false);
        expect(runtime.registerPreview({ resource, accountId: 'other_account' })).toEqual({ ok: false, reasonCode: 'invalid_preview_resource' });
    });
    it('refuses retired path-mode registrations without granting preview access', () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: 'preview.happier.test' });
        // @ts-expect-error Retired wire input must fail closed at runtime too.
        const result = runtime.registerPreview({ resource: { ...hostResource, originMode: 'path' }, accountId: 'account_1' });
        expect(result).toEqual({ ok: false, reasonCode: 'invalid_preview_resource' });
        expect(runtime.resolvePreview(hostResource.previewId)).toBeNull();
        expect(runtime.resolvePreviewByHost('alpha-beta.preview.happier.test')).toBeNull();
    });
    it("keeps an existing viewer authorized when another viewer opens the same resource", () => {
        let serial = 0;
        const runtime = createLocalServicePreviewRuntime({
            tokenSecret: "secret",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            nowMs: () => 1_000,
            generateRawToken: () => `viewer-${++serial}`,
        });
        const binding = { previewId: hostResource.previewId, sessionId: hostResource.sessionId, machineId: hostResource.machineId };
        const first = runtime.registerPreview({ resource: hostResource, accountId: "account_1" });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const firstViewer = runtime.exchangeAccessToken({ ...binding, rawToken: new URL(first.accessUrl ?? '').searchParams.get("previewToken") });
        expect(firstViewer.ok).toBe(true);
        if (!firstViewer.ok) return;
        const second = runtime.registerPreview({ resource: hostResource, accountId: "account_1" });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        const secondViewer = runtime.exchangeAccessToken({ ...binding, rawToken: new URL(second.accessUrl ?? '').searchParams.get("previewToken") });
        expect(secondViewer.ok).toBe(true);
        if (!secondViewer.ok) return;
        expect(runtime.validateAccess({ ...binding, rawToken: firstViewer.rawToken })).toEqual({ ok: true });
        expect(runtime.validateAccess({ ...binding, rawToken: secondViewer.rawToken })).toEqual({ ok: true });
        runtime.unregisterPreview(hostResource.previewId);
        expect(runtime.validateAccess({ ...binding, rawToken: firstViewer.rawToken })).toEqual({ ok: false, reasonCode: "preview_not_found" });
        expect(runtime.validateAccess({ ...binding, rawToken: secondViewer.rawToken })).toEqual({ ok: false, reasonCode: "preview_not_found" });
    });

    it("registers a preview resource, issues a scoped token, and resolves a load URL", async () => {
        const mod = await loadPreviewRuntimeModule();
        expect(mod?.createLocalServicePreviewRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewRuntime) return;

        const rawTokens = ["raw_url_token_1", "raw_cookie_token_1"];
        const tokenIds = ["token_id_url_1", "token_id_cookie_1"];
        const runtime = mod.createLocalServicePreviewRuntime({
            tokenSecret: "secret",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            nowMs: () => 1_000,
            generateTokenId: () => tokenIds.shift() ?? "token_id_extra",
            generateRawToken: () => rawTokens.shift() ?? "raw_extra",
            tokenTtlMs: 60_000,
        });

        const registered = runtime.registerPreview({
            resource,
            accountId: "account_1",
        });
        expect(registered).toEqual({
            ok: true,
            resource,
            accessUrl: "https://preview-1.preview.happier.test/dashboard?tab=preview&previewToken=raw_url_token_1",
            expiresAt: 61_000,
        });
        expect(runtime.resolvePreview("preview_1")).toEqual(resource);
        expect(runtime.resolvePreviewContext("preview_1")).toEqual({
            resource,
            accountId: "account_1",
        });
        expect(runtime.validateAccess({
            previewId: "preview_1",
            rawToken: "raw_url_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        })).toEqual({ ok: false, reasonCode: "exchange_mode_mismatch" });

        const exchanged = runtime.exchangeAccessToken({
            previewId: "preview_1",
            rawToken: "raw_url_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        });
        expect(exchanged).toEqual({
            ok: true,
            rawToken: "raw_cookie_token_1",
            expiresAt: null,
        });
        expect(runtime.validateAccess({
            previewId: "preview_1",
            rawToken: "raw_cookie_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        })).toEqual({ ok: true });
        expect(runtime.exchangeAccessToken({
            previewId: "preview_1",
            rawToken: "raw_url_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        })).toEqual({ ok: false, reasonCode: "token_mismatch" });
        expect(runtime.validateAccess({
            previewId: "preview_1",
            rawToken: "raw_url_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        })).toEqual({ ok: false, reasonCode: "token_mismatch" });
    });

    it("fails closed when token configuration is incomplete", async () => {
        const mod = await loadPreviewRuntimeModule();
        expect(mod?.createLocalServicePreviewRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewRuntime) return;

        const runtime = mod.createLocalServicePreviewRuntime({
            tokenSecret: "",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            nowMs: () => 1_000,
        });

        expect(runtime.registerPreview({
            resource,
            accountId: "account_1",
        })).toEqual({
            ok: false,
            reasonCode: "preview_token_secret_missing",
        });
    });

    it("revokes token access when a preview is unregistered", async () => {
        const mod = await loadPreviewRuntimeModule();
        expect(mod?.createLocalServicePreviewRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewRuntime) return;

        let now = 1_000;
        const runtime = mod.createLocalServicePreviewRuntime({
            tokenSecret: "secret",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            nowMs: () => now,
            generateTokenId: () => "token_id_1",
            generateRawToken: () => "raw_token_1",
            tokenTtlMs: 60_000,
        });

        expect(runtime.registerPreview({
            resource,
            accountId: "account_1",
        }).ok).toBe(true);
        now = 2_000;
        expect(runtime.unregisterPreview("preview_1")).toEqual({ ok: true });
        expect(runtime.resolvePreview("preview_1")).toBeNull();
        expect(runtime.resolvePreviewContext("preview_1")).toBeNull();
        expect(runtime.validateAccess({
            previewId: "preview_1",
            rawToken: "raw_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        })).toEqual({ ok: false, reasonCode: "preview_not_found" });
    });

    it("fails closed when a second host-mode preview sanitizes to an occupied hostname", async () => {
        const mod = await loadPreviewRuntimeModule();
        expect(mod?.createLocalServicePreviewRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewRuntime) return;

        const runtime = mod.createLocalServicePreviewRuntime({
            tokenSecret: "secret",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            nowMs: () => 1_000,
            generateTokenId: () => "token_id_1",
            generateRawToken: () => "raw_token_1",
            tokenTtlMs: 60_000,
        });

        expect(runtime.registerPreview({
            resource: hostResource,
            accountId: "account_1",
        })).toEqual({
            ok: true,
            resource: hostResource,
            accessUrl: "https://alpha-beta.preview.happier.test/dashboard?tab=preview&previewToken=raw_token_1",
            expiresAt: 61_000,
        });

        const collidingResource: LocalServicePreviewResourceV1 = {
            ...hostResource,
            previewId: "alpha__beta",
        };

        expect(runtime.registerPreview({
            resource: collidingResource,
            accountId: "account_2",
        })).toEqual({
            ok: false,
            reasonCode: "preview_hostname_collision",
        });
        expect(runtime.resolvePreview("alpha-beta")).toEqual(hostResource);
        expect(runtime.resolvePreview("alpha__beta")).toBeNull();
        expect(runtime.resolvePreviewByHost("alpha-beta.preview.happier.test")).toEqual(hostResource);
    });
});
