import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";

import { createLocalServicePublicRuntime } from "./runtime";
import { createLocalServicePublicRateLimitChecker } from "./rateLimits";

const publicRuntimeModule = { createLocalServicePublicRuntime };

async function loadPublicRuntimeModule(): Promise<typeof publicRuntimeModule> {
    return publicRuntimeModule;
}

const preview: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: 5173 },
    initialPath: { pathname: "/", search: "" },
    display: {
        title: "Vite App",
        addressLabel: "127.0.0.1:5173",
    },
    originMode: "host",
};

describe("local service public exposure runtime", () => {
    it('recreates an individual people share after individual and Team revocations', () => {
        let exposureIndex = 0;
        const runtime = createLocalServicePublicRuntime({
            publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
            tokenSecret: 'fixture-key',
            policy: { enabled: true, allowedModes: ['people'], maxTtlMs: 600_000,
                maxConcurrentExposures: 1, dnsTlsRequired: false, auditRequired: true,
                rateLimitProfileIds: ['default'] },
            nowMs: () => 1_000, generateExposureId: () => `people-${++exposureIndex}`,
            allowTestDevAuditSink: true, recordAuditEvent: () => {},
            checkRateLimit: createLocalServicePublicRateLimitChecker({ kind: 'test_dev' }),
            resolvePreview: () => preview,
        });
        const audiences = [
            [{ kind: 'account' as const, accountId: 'recipient' }],
            [{ kind: 'account' as const, accountId: 'recipient' }],
            [{ kind: 'team' as const, teamId: 'team' }],
            [{ kind: 'account' as const, accountId: 'recipient' }],
        ];
        const createdIds: string[] = [];
        for (const audience of audiences) {
            const result = runtime.createExposure({ preview, requestedMode: 'people', requestedTtlMs: 600_000,
                actorId: 'creator', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default',
                audience, landingBaseUrl: 'https://app.example.test' });
            expect(result).toMatchObject({ ok: true, exposure: { state: 'active', audience } });
            if (!result.ok) throw new Error(result.reasonCode);
            createdIds.push(result.exposure.exposureId);
            expect(runtime.getSnapshot({ machineId: preview.machineId }).exposures.filter(item => item.state === 'active'))
                .toEqual([result.exposure]);
            expect(runtime.revokeExposure(result.exposure.exposureId, { actorId: 'creator' })).toEqual({ ok: true });
        }
        expect(new Set(createdIds).size).toBe(audiences.length);
        expect(runtime.getSnapshot({ machineId: preview.machineId }).exposures.map(item => item.state))
            .toEqual(['revoked', 'revoked', 'revoked', 'revoked']);
    });
    it('publishes one content-free change per exposure lifecycle transition, never per status read', () => {
        // The publisher is the socket transport boundary; exposure lifecycle remains real.
        const onExposureChanged = vi.fn();
        const runtime = createLocalServicePublicRuntime({
            publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
            tokenSecret: 'fixture-key',
            policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 60_000,
                dnsTlsRequired: false, auditRequired: true, rateLimitProfileIds: ['default'] },
            nowMs: () => 1_000, allowTestDevAuditSink: true,
            recordAuditEvent: () => {}, checkRateLimit: () => true, onExposureChanged,
        });
        const result = runtime.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'creator', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
        if (!result.ok) throw new Error(result.reasonCode);
        const expected = { actorId: 'creator', owner: preview.owner, sessionId: preview.sessionId,
            change: { type: 'local-service-public-preview-changed', machineId: preview.machineId,
                previewId: preview.previewId, exposureId: result.exposure.exposureId } };
        expect(onExposureChanged.mock.calls).toEqual([[expected]]);
        for (let read = 0; read < 10; read++) runtime.getSnapshot({ machineId: preview.machineId });
        expect(onExposureChanged).toHaveBeenCalledTimes(1);
        expect(runtime.revokeExposure(result.exposure.exposureId, { actorId: 'creator' })).toEqual({ ok: true });
        expect(onExposureChanged.mock.calls).toEqual([[expected], [expected]]);
        expect(runtime.getSnapshot({ machineId: preview.machineId }).exposures[0]?.state).toBe('revoked');
        expect(JSON.stringify(onExposureChanged.mock.calls)).not.toContain('publicUrl');
        expect(JSON.stringify(onExposureChanged.mock.calls)).not.toContain('fixture-key');
    });
    it('creates the minimum positive TTL from one issuance timestamp when the clock advances', () => {
        let now = 1_000;
        const runtime = createLocalServicePublicRuntime({
            publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
            tokenSecret: 'fixture-key',
            policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 60_000,
                dnsTlsRequired: false, auditRequired: true, rateLimitProfileIds: ['default'] },
            nowMs: () => now++, allowTestDevAuditSink: true,
            recordAuditEvent: () => {}, checkRateLimit: () => true,
        });
        const result = runtime.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 1,
            actorId: 'owner', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });

        expect(result).toMatchObject({ ok: true, exposure: { issuedAt: 1_000, expiresAt: 1_001 } });
    });

    it('uses the exposure deadline beyond the platform timer range and releases the retained timer', () => {
        vi.useFakeTimers();
        try {
            const timerRangeMs = 2_147_483_647;
            const ttlMs = timerRangeMs + 100;
            const closed: string[] = [];
            let closedBeforeAudit = false;
            const runtime = createLocalServicePublicRuntime({
                publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
                policy: { enabled: true, allowedModes: ['public'], maxTtlMs: ttlMs,
                    dnsTlsRequired: false, auditRequired: true, rateLimitProfileIds: ['default'] },
                allowTestDevAuditSink: true, checkRateLimit: () => true,
                recordAuditEvent(event) {
                    if (event.action === 'expire') {
                        closedBeforeAudit = closed.includes('http') && closed.includes('ws');
                        throw new Error('audit boundary unavailable');
                    }
                },
            });
            const created = runtime.createExposure({ preview, requestedMode: 'public', requestedTtlMs: ttlMs,
                actorId: 'owner', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
            if (!created.ok) throw new Error(created.reasonCode);
            const id = created.exposure.exposureId;
            const release = runtime.retainConnection(id, () => { closed.push('released'); });
            expect(vi.getTimerCount()).toBe(1);
            release();
            expect(vi.getTimerCount()).toBe(0);
            runtime.retainConnection(id, () => { closed.push('http'); });
            runtime.retainConnection(id, () => { closed.push('ws'); });
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(timerRangeMs);
            expect(closed).toEqual([]);
            expect(runtime.resolveExposure(id)?.state).toBe('active');
            vi.advanceTimersByTime(100);
            expect(closed).toEqual(['http', 'ws']);
            expect(closedBeforeAudit).toBe(true);
            expect(runtime.resolveExposure(id)?.state).toBe('expired');
            expect(runtime.getSnapshot({ machineId: preview.machineId }).diagnostics).toEqual([
                expect.objectContaining({ details: { reasonCode: 'audit_sink_unavailable' } }),
            ]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('scopes registered-preview status to the exact source-qualified service occurrence', () => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: preview.machineId, managedServiceId: 'actual-instance', cwd: '/workspace/app',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } };
        const native = { ...preview, sessionId: undefined, owner: { kind: 'user' as const, id: 'starter' }, serviceTarget };
        const runtime = createLocalServicePublicRuntime({ publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
            tokenSecret: 'public-secret', policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 60_000,
                dnsTlsRequired: false, auditRequired: true, rateLimitProfileIds: ['default'] }, nowMs: () => 1_000,
            generateExposureId: () => 'actual-public', allowTestDevAuditSink: true,
            recordAuditEvent: () => {}, checkRateLimit: () => true, resolvePreview: () => native });
        const created = runtime.createExposure({ preview: native, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'creator', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
        if (!created.ok) throw new Error(created.reasonCode);
        const request = { machineId: native.machineId, previewId: native.previewId, serviceTarget };
        expect(runtime.getSnapshot(request).exposures).toEqual([created.exposure]);
        // The by-id compatibility read remains, while an explicit source cannot
        // read a different occurrence's retained exposure or shareable URL.
        expect(runtime.getSnapshot({ machineId: native.machineId, previewId: native.previewId }).exposures).toEqual([created.exposure]);
        expect(runtime.getSnapshot({ ...request, serviceTarget: { ...serviceTarget, managedServiceId: 'another-instance' } }).exposures).toEqual([]);
    });
    it('retires only the sessionless exposures of the Account that lost the Machine', () => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: preview.machineId, managedServiceId: 'actual-instance', cwd: '/workspace/app',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } };
        const native = { ...preview, sessionId: undefined, owner: { kind: 'user' as const, id: 'starter' }, serviceTarget };
        let exposureIndex = 0;
        const runtime = createLocalServicePublicRuntime({ publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
            tokenSecret: 'public-secret', policy: { enabled: true, allowedModes: ['secret_link', 'public'], maxTtlMs: 60_000, maxConcurrentExposures: 2,
                dnsTlsRequired: false, auditRequired: true, rateLimitProfileIds: ['default'] }, nowMs: () => 1_000,
            generateExposureId: () => `public_${++exposureIndex}`, allowTestDevAuditSink: true,
            recordAuditEvent: () => {}, checkRateLimit: () => true, resolvePreview: () => native });
        const create = (actorId: string, requestedMode: 'secret_link' | 'public') => {
            const result = runtime.createExposure({ preview: native, requestedMode, requestedTtlMs: 60_000, actorId,
                sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
            expect(result).toMatchObject({ ok: true, exposure: { serviceTarget } });
            if (!result.ok) throw new Error(result.reasonCode);
            return result.exposure;
        };
        const first = create('creator_1', 'secret_link');
        const second = create('creator_2', 'public');
        const exchanged = runtime.exchangeAccessToken({ exposureId: first.exposureId,
            rawToken: new URL(first.publicUrl).searchParams.get('publicToken') });
        if (!exchanged.ok) throw new Error(exchanged.reasonCode);
        let firstClosed = false;
        let retainedClosed = false;
        runtime.retainConnection(first.exposureId, () => { firstClosed = true; });
        runtime.retainConnection(second.exposureId, () => { retainedClosed = true; });
        runtime.retireMachineAccess({ machineId: 'another-machine', accountId: 'creator_1' });
        expect(firstClosed).toBe(false);
        runtime.retireMachineAccess({ machineId: native.machineId, accountId: 'creator_1' });
        expect(firstClosed).toBe(true);
        expect(retainedClosed).toBe(false);
        expect(runtime.resolveExposure(first.exposureId)?.state).toBe('revoked');
        expect(runtime.resolveExposure(second.exposureId)?.state).toBe('active');
        expect(runtime.validateAccess({ exposureId: first.exposureId, rawToken: exchanged.rawToken, clientKey: 'anonymous' })).toMatchObject({ ok: false, reasonCode: 'revoked' });
        expect(runtime.validateAccess({ exposureId: second.exposureId, rawToken: null, clientKey: 'creator_2' })).toEqual({ ok: true, preview: native });
    });
    it("creates a TTL-bound secret-link exposure with an audit event and access token", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: true,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
        });

        const result = runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 120_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });

        expect(result).toEqual({
            ok: true,
            exposure: {
                exposureId: "public_preview_1",
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                state: "active",
                publicUrl: "https://public-preview-1.preview.example.test/v1/local-services/public/public_preview_1?publicToken=secret_token_1",
                issuedAt: 1_000,
                expiresAt: 61_000,
                auditEventIds: ["audit_create_1"],
                rateLimitProfileId: "default",
            },
        });
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        })).toEqual({
            ok: true,
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            expiresAt: 61_000,
        });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: true, preview });
    });

    function createPeopleRuntime(deps: Readonly<{ members?: readonly string[]; holds?: () => boolean }> = {}) {
        let tokenIndex = 0;
        return createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: { enabled: true, allowedModes: ["people"], maxTtlMs: 60_000, dnsTlsRequired: false,
                auditRequired: true, rateLimitProfileIds: ["default"] },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => `token_${++tokenIndex}`,
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
            peopleAdmission: {
                isInAudience: async ({ viewerAccountId }) => (deps.members ?? ["viewer_b"]).includes(viewerAccountId),
                sharerHoldsService: async () => deps.holds?.() ?? true,
            },
        });
    }

    function createPeopleExposure(runtime: ReturnType<typeof createPeopleRuntime>, sharedPreview: LocalServicePreviewResourceV1 = preview) {
        return runtime.createExposure({ preview: sharedPreview, requestedMode: "people", requestedTtlMs: 60_000, actorId: "sharer_a",
            sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: "default",
            audience: [{ kind: "account", accountId: "viewer_b" }], landingBaseUrl: "https://app.happier.test" });
    }

    it("links a people share to the app landing and admits only the viewer cookie its one-use admission minted", async () => {
        const runtime = createPeopleRuntime();
        const created = createPeopleExposure(runtime);
        if (!created.ok) throw new Error(created.reasonCode);
        expect(created.exposure).toMatchObject({ mode: "people", audience: [{ kind: "account", accountId: "viewer_b" }],
            publicUrl: "https://app.happier.test/preview-link/public_preview_1" });
        expect(runtime.resolveExposureByHost("public-preview-1.preview.example.test")?.exposureId).toBe("public_preview_1");
        expect(runtime.resolveExposureByHost("app.happier.test")).toBeNull();

        // Without an admission there is no cookie the data plane accepts.
        expect(runtime.validateAccess({ exposureId: "public_preview_1", rawToken: null, clientKey: "b" }))
            .toEqual({ ok: false, reasonCode: "admission_required" });

        const admitted = await runtime.admitViewer({ exposureId: "public_preview_1", viewerAccountId: "viewer_b" });
        if (!admitted.ok) throw new Error(admitted.reasonCode);
        const admissionUrl = new URL(admitted.admissionUrl);
        expect(admissionUrl.origin).toBe("https://public-preview-1.preview.example.test");
        const admissionToken = admissionUrl.searchParams.get("publicToken");
        expect(runtime.validateAccess({ exposureId: "public_preview_1", rawToken: admissionToken, clientKey: "b" }))
            .toEqual({ ok: false, reasonCode: "admission_required" });

        const exchanged = runtime.exchangeAccessToken({ exposureId: "public_preview_1", rawToken: admissionToken });
        if (!exchanged.ok) throw new Error(exchanged.reasonCode);
        expect(exchanged.rawToken).not.toBe(admissionToken);
        expect(runtime.exchangeAccessToken({ exposureId: "public_preview_1", rawToken: admissionToken }))
            .toEqual({ ok: false, reasonCode: "public_token_mismatch" });
        expect(runtime.validateAccess({ exposureId: "public_preview_1", rawToken: exchanged.rawToken, clientKey: "b" }))
            .toEqual({ ok: true, preview });

        expect(runtime.revokeExposure("public_preview_1", { actorId: "sharer_a" })).toEqual({ ok: true });
        expect(runtime.validateAccess({ exposureId: "public_preview_1", rawToken: exchanged.rawToken, clientKey: "b" }))
            .toEqual({ ok: false, reasonCode: "revoked" });
        expect(await runtime.admitViewer({ exposureId: "public_preview_1", viewerAccountId: "viewer_b" }))
            .toEqual({ ok: false, reasonCode: "revoked" });
    });

    it("admits a Session preview on its current registration, re-proving the sharer's Machine only for a Service", async () => {
        // A Session-bound preview has no managed Service to re-prove; its current registration is the fact.
        const runtime = createPeopleRuntime({ holds: () => false });
        expect(createPeopleExposure(runtime).ok).toBe(true);
        expect(preview.serviceTarget).toBeUndefined();
        const admitted = await runtime.admitViewer({ exposureId: "public_preview_1", viewerAccountId: "viewer_b" });
        expect(admitted.ok).toBe(true);
    });

    it("refuses people admission outside the audience, without the sharer's Service, and for other modes", async () => {
        let holds = true;
        const runtime = createPeopleRuntime({ holds: () => holds });
        const serviceTarget = { kind: 'managed_service' as const, machineId: preview.machineId, managedServiceId: 'svc', cwd: '/workspace/app',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } };
        expect(createPeopleExposure(runtime, { ...preview, sessionId: undefined, owner: { kind: 'user', id: 'sharer_a' }, serviceTarget }).ok).toBe(true);
        expect(await runtime.admitViewer({ exposureId: "public_preview_1", viewerAccountId: "outsider_c" }))
            .toEqual({ ok: false, reasonCode: "not_in_audience" });
        holds = false;
        expect(await runtime.admitViewer({ exposureId: "public_preview_1", viewerAccountId: "viewer_b" }))
            .toEqual({ ok: false, reasonCode: "service_unavailable" });
        expect(await runtime.admitViewer({ exposureId: "missing", viewerAccountId: "viewer_b" }))
            .toEqual({ ok: false, reasonCode: "exposure_not_found" });

        const linkRuntime = createPublicModeRuntime(await loadPublicRuntimeModule());
        expect(createPublicModeExposure(linkRuntime).ok).toBe(true);
        expect(await linkRuntime.admitViewer({ exposureId: "public_preview_1", viewerAccountId: "viewer_b" }))
            .toEqual({ ok: false, reasonCode: "not_people_share" });
    });

    it("returns a scoped public preview snapshot without leaking public tokens", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let exposureIndex = 0;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => {
                exposureIndex += 1;
                return `public_preview_${exposureIndex}`;
            },
            generateSecretToken: () => `secret_token_${exposureIndex + 1}`,
            generateAuditEventId: () => `audit_create_${exposureIndex}`,
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.createExposure({
            preview: {
                ...preview,
                previewId: "preview_2",
            },
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);

        const snapshot = runtime.getSnapshot({
            machineId: "machine_1",
            sessionId: "session_1",
            previewId: "preview_1",
        });

        expect(snapshot).toEqual({
            v: 1,
            machineId: "machine_1",
            sessionId: "session_1",
            previewId: "preview_1",
            generatedAt: 1_000,
            refreshState: "idle",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: [],
            },
            exposures: [
                expect.objectContaining({
                    exposureId: "public_preview_1",
                    previewId: "preview_1",
                    publicUrl: "https://public-preview-1.preview.example.test/v1/local-services/public/public_preview_1?publicToken=secret_token_1",
                }),
            ],
            diagnostics: [],
        });
        expect(JSON.stringify(snapshot)).not.toContain("secret_token_2");
    });

    it("fails closed by default and does not create exposure state", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            policy: {},
            nowMs: () => 1_000,
            checkRateLimit: () => true,
        });

        const result = runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });

        expect(result).toEqual({ ok: false, reasonCode: "public_preview_disabled" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("fails closed when policy requires audit but no audit sink is available", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "audit_sink_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("fails closed when policy requires audit but the sink is not durable or explicitly test/dev", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "audit_sink_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("fails closed when a rate-limit profile is advertised but no checker is available", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            // Deliberately no `checkRateLimit`: S-5 makes a checker a hard prerequisite for
            // minting, so this must refuse rather than mint an unlimited exposure.
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "rate_limit_checker_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toBeNull();
    });

    it("fails closed on access when the durable audit sink rejects the access audit write", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let auditWrites = 0;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditWrites === 0 ? "audit_create_1" : "audit_access_1",
            auditSinkDurable: true,
            recordAuditEvent: () => {
                auditWrites += 1;
                if (auditWrites > 1) {
                    throw new Error("durable audit unavailable");
                }
            },
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "audit_sink_unavailable" });
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            auditEventIds: ["audit_create_1"],
        }));
    });

    it("revokes retained access and records failure when the durable audit sink rejects the revoke audit write", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let auditWrites = 0;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditWrites === 0 ? "audit_create_1" : "audit_revoke_1",
            auditSinkDurable: true,
            recordAuditEvent: () => {
                auditWrites += 1;
                if (auditWrites > 1) {
                    throw new Error("durable audit unavailable");
                }
            },
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);

        let closed = false;
        runtime.retainConnection("public_preview_1", () => { closed = true; });
        expect(runtime.revokeExposure("public_preview_1", { actorId: "user_1" })).toEqual({
            ok: false,
            reasonCode: "audit_sink_unavailable",
        });
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "revoked",
            auditEventIds: ["audit_create_1"],
        }));
        expect(closed).toBe(true);
        expect(runtime.getSnapshot({ machineId: preview.machineId }).diagnostics).toEqual([
            expect.objectContaining({ details: { reasonCode: "audit_sink_unavailable" } }),
        ]);
    });

    it("fails closed on access when the configured rate-limit checker is unavailable", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            auditSinkDurable: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => {
                throw new Error("rate checker unavailable");
            },
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "rate_limit_checker_unavailable" });
    });

    it("validates secret-link tokens before applying rate-limit state changes", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        let rateLimitChecks = 0;
        const auditIds = ["audit_create_1", "audit_denied_1", "audit_rate_limit_1", "audit_denied_2"];
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            checkRateLimit: () => {
                rateLimitChecks += 1;
                return false;
            },
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "wrong_token",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "public_token_mismatch" });
        expect(rateLimitChecks).toBe(0);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "active",
        }));

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "rate_limited" });
        expect(rateLimitChecks).toBe(1);
        // S-5: the refusal is per-request. The exposure stays active so the link is not bricked.
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "active",
        }));
        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "public_token_mismatch",
            }),
            expect.objectContaining({ eventId: "audit_rate_limit_1", action: "rate_limit" }),
            expect.objectContaining({
                eventId: "audit_denied_2",
                action: "access_denied",
                reasonCode: "rate_limited",
            }),
        ]);
    });

    it("admits repeated share-link visits without consuming or rotating the shared credential", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let rateLimitChecks = 0;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => {
                rateLimitChecks += 1;
                return true;
            },
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);

        const exchange = runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        });
        expect(exchange).toEqual({
            ok: true,
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            expiresAt: 61_000,
        });
        expect(runtime.exchangeAccessToken({ exposureId: "public_preview_1", rawToken: "secret_token_1" })).toEqual(exchange);
        // Exchanging only strips the credential into the scoped cookie. Proxy admission owns abuse control.
        expect(rateLimitChecks).toBe(0);

        // Both recipients retain access after another viewer opens the same URL.
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: true, preview });
        expect(rateLimitChecks).toBe(1);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_b",
        })).toEqual({ ok: true, preview });
        expect(rateLimitChecks).toBe(2);
    });

    it("rejects exchanging an unknown exposure or a mismatched token", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => "audit_create_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
        });

        expect(runtime.exchangeAccessToken({
            exposureId: "missing_exposure",
            rawToken: "secret_token_1",
        })).toEqual({ ok: false, reasonCode: "exposure_not_found" });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);

        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "wrong_token",
        })).toEqual({ ok: false, reasonCode: "public_token_mismatch" });

        // A failed exchange does not consume the valid shared credential.
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: true, preview });
    });

    it("enforces the configured maximum number of active exposures", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let exposureIndex = 0;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                maxConcurrentExposures: 1,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => {
                exposureIndex += 1;
                return `public_preview_${exposureIndex}`;
            },
            generateSecretToken: () => `secret_token_${exposureIndex + 1}`,
            generateAuditEventId: () => `audit_create_${exposureIndex}`,
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.createExposure({
            preview: {
                ...preview,
                previewId: "preview_2",
            },
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        })).toEqual({ ok: false, reasonCode: "too_many_public_exposures" });
        expect(runtime.resolveExposure("public_preview_2")).toBeNull();
    });

    it("revokes active exposures immediately", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let now = 1_000;
        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_revoke_1", "audit_denied_1"];
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => now,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        now = 2_000;
        expect(runtime.revokeExposure("public_preview_1", { actorId: "user_1" })).toEqual({ ok: true });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "revoked" });
        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({ eventId: "audit_revoke_1", action: "revoke" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "revoked",
            }),
        ]);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "revoked",
            revokedAt: 2_000,
            auditEventIds: ["audit_create_1", "audit_revoke_1", "audit_denied_1"],
        }));
    });

    it("records successful and denied access audit events without storing raw public tokens", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_access_1", "audit_denied_1"];
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: true, preview });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "wrong_token",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "public_token_mismatch" });

        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({ eventId: "audit_access_1", action: "access" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "public_token_mismatch",
            }),
        ]);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            auditEventIds: ["audit_create_1", "audit_access_1", "audit_denied_1"],
        }));
        expect(JSON.stringify(auditEvents)).not.toContain("secret_token_1");
        expect(JSON.stringify(auditEvents)).not.toContain("wrong_token");
    });

    it("revalidates the underlying preview mapping before allowing continued public access", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_denied_1", "audit_denied_2"];
        let resolvedPreview: LocalServicePreviewResourceV1 | null = preview;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            resolvePreview: () => resolvedPreview,
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        resolvedPreview = null;
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "preview_not_found" });

        resolvedPreview = {
            ...preview,
            machineId: "machine_2",
        };
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "preview_mismatch" });

        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "preview_not_found",
            }),
            expect.objectContaining({
                eventId: "audit_denied_2",
                action: "access_denied",
                reasonCode: "preview_mismatch",
            }),
        ]);
    });

    it("marks an active exposure expired and records every expired access denial", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let now = 1_000;
        const auditEvents: unknown[] = [];
        const auditIds = ["audit_create_1", "audit_expire_1", "audit_denied_1", "audit_denied_2"];
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 1_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => now,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => auditIds.shift() ?? "audit_extra",
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 1_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);

        now = 2_000;
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "expired" });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "expired" });

        expect(auditEvents).toEqual([
            expect.objectContaining({ eventId: "audit_create_1", action: "create" }),
            expect.objectContaining({ eventId: "audit_expire_1", action: "expire" }),
            expect.objectContaining({
                eventId: "audit_denied_1",
                action: "access_denied",
                reasonCode: "expired",
            }),
            expect.objectContaining({
                eventId: "audit_denied_2",
                action: "access_denied",
                reasonCode: "expired",
            }),
        ]);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "expired",
            auditEventIds: ["audit_create_1", "audit_expire_1", "audit_denied_1", "audit_denied_2"],
        }));
    });

    it("keeps a rate-limited exposure usable in the next window instead of bricking the link", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        const auditEvents: unknown[] = [];
        let auditSequence = 0;
        let nowMs = 1_000;
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => nowMs,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => {
                auditSequence += 1;
                return `audit_${auditSequence}`;
            },
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            checkRateLimit: createLocalServicePublicRateLimitChecker({ kind: "fixed_window", maxRequests: 1, windowMs: 1_000 }),
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: true, preview });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "rate_limited" });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: false, reasonCode: "rate_limited" });

        // S-5: every refusal is audited...
        expect(auditEvents.filter((event) => (event as { action?: string }).action === "rate_limit")).toHaveLength(2);
        expect(auditEvents.filter((event) => (event as { reasonCode?: string }).reasonCode === "rate_limited")).toHaveLength(2);
        // ...but the exposure itself stays ACTIVE. Persisting `state:'rate_limited'` made
        // `isLocalServicePublicExposureAccessible` treat the link as permanently dead, so a single
        // visitor exceeding the window bricked it for everyone holding it.
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            state: "active",
        }));
        nowMs += 1_000;
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
            clientKey: "client_a",
        })).toEqual({ ok: true, preview });
    });

    it("bounds exposure audit event ids while recording every audit event", async () => {
        const mod = await loadPublicRuntimeModule();
        expect(mod?.createLocalServicePublicRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePublicRuntime) return;

        let auditIndex = 0;
        const auditEvents: unknown[] = [];
        const runtime = mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["secret_link"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateSecretToken: () => "secret_token_1",
            generateAuditEventId: () => {
                auditIndex += 1;
                return `audit_${auditIndex}`;
            },
            allowTestDevAuditSink: true,
            recordAuditEvent: (event) => auditEvents.push(event),
            maxExposureAuditEventIds: 2,
            checkRateLimit: () => true,
        });

        expect(runtime.createExposure({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        }).ok).toBe(true);
        expect(runtime.exchangeAccessToken({
            exposureId: "public_preview_1",
            rawToken: "secret_token_1",
        }).ok).toBe(true);
        for (let index = 0; index < 3; index += 1) {
            expect(runtime.validateAccess({
                exposureId: "public_preview_1",
                rawToken: "secret_token_1",
                clientKey: "client_a",
            }).ok).toBe(true);
        }

        expect(auditEvents).toHaveLength(4);
        expect(runtime.resolveExposure("public_preview_1")).toEqual(expect.objectContaining({
            auditEventIds: ["audit_3", "audit_4"],
        }));
    });

    function createPublicModeRuntime(
        mod: Awaited<ReturnType<typeof loadPublicRuntimeModule>>,
        overrides: Partial<Parameters<typeof mod.createLocalServicePublicRuntime>[0]> = {},
    ) {
        return mod.createLocalServicePublicRuntime({
            publicBaseUrl: "https://preview.happier.test",
            hostOriginBaseDomain: "preview.example.test",
            tokenSecret: "public-secret",
            policy: {
                enabled: true,
                allowedModes: ["public"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: ["default"],
            },
            nowMs: () => 1_000,
            generateExposureId: () => "public_preview_1",
            generateAuditEventId: () => "audit_1",
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
            checkRateLimit: () => true,
            ...overrides,
        });
    }

    function createPublicModeExposure(runtime: ReturnType<typeof createPublicModeRuntime>) {
        return runtime.createExposure({
            preview,
            requestedMode: "public",
            requestedTtlMs: 60_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });
    }

    // S-3
    it("mints a public exposure on its own isolated origin and refuses without one", async () => {
        const mod = await loadPublicRuntimeModule();

        const isolated = createPublicModeExposure(createPublicModeRuntime(mod));
        expect(isolated.ok).toBe(true);
        if (!isolated.ok) return;
        const exposureOrigin = new URL(isolated.exposure.publicUrl).origin;
        expect(exposureOrigin).toBe("https://public-preview-1.preview.example.test");
        expect(exposureOrigin).not.toBe(new URL("https://preview.happier.test").origin);

        for (const overrides of [
            { hostOriginBaseDomain: null },
            { hostOriginBaseDomain: "not a domain" },
            { publicBaseUrl: "http://preview.happier.test" },
        ]) {
            expect(createPublicModeExposure(createPublicModeRuntime(mod, overrides))).toEqual({
                ok: false,
                reasonCode: "public_origin_unavailable",
            });
        }
    });

    // S-5
    it("requires a rate-limit checker to mint an exposure even without configured profiles", async () => {
        const mod = await loadPublicRuntimeModule();
        const runtime = createPublicModeRuntime(mod, {
            policy: {
                enabled: true,
                allowedModes: ["public"],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                // Empty, which is the DEFAULT configuration: the old runtime only refused when
                // profiles were configured, so the default enabled deployment had no limiting.
                rateLimitProfileIds: [],
            },
            checkRateLimit: undefined,
        });

        expect(createPublicModeExposure(runtime)).toEqual({
            ok: false,
            reasonCode: "rate_limit_checker_unavailable",
        });

    });

    // S-5
    it("buckets the rate limiter per client so one visitor cannot exhaust the window", async () => {
        const mod = await loadPublicRuntimeModule();
        const runtime = createPublicModeRuntime(mod, {
            checkRateLimit: createLocalServicePublicRateLimitChecker({ kind: "fixed_window", maxRequests: 1, windowMs: 60_000 }),
        });
        expect(createPublicModeExposure(runtime).ok).toBe(true);

        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: null,
            clientKey: "noisy_client",
        })).toEqual({ ok: true, preview });
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: null,
            clientKey: "noisy_client",
        })).toEqual({ ok: false, reasonCode: "rate_limited" });

        // The next visitor is unaffected, and the exposure is still active.
        expect(runtime.validateAccess({
            exposureId: "public_preview_1",
            rawToken: null,
            clientKey: "quiet_client",
        })).toEqual({ ok: true, preview });
    });
});
