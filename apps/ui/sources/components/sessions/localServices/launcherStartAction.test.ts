import { describe, expect, it, vi } from 'vitest';

import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type {
    LocalServiceLauncherSnapshotV1,
    RuntimeActionExecute,
    ApprovalRequestV2,
} from '@happier-dev/protocol';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import type { ActionApprovalRegistration, ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { renderHook } from '@/dev/testkit';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { areServerProfileIdentifiersEquivalent, removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

const startedSnapshot = {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 2_000,
    targets: [{
        id: 'managed:preview',
        source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Preview',
        confidence: 'medium',
        state: 'starting',
        actions: [],
    }],
} satisfies LocalServiceLauncherSnapshotV1;

const startableTarget = {
    id: 'managed:preview',
    source: 'managed_service',
    sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
    machineId: 'machine-a',
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    title: 'Preview',
    confidence: 'medium',
    state: 'available',
    actions: ['start'],
} satisfies LocalServiceLaunchTarget;

type StartActionContextWithSnapshotApply = Readonly<{
    runtimeActionExecute?: RuntimeActionExecute | null;
    machineId?: string | null;
    sessionId?: string | null;
    workspaceId?: string | null;
    serverId?: string | null;
    applyLauncherSnapshot?: (snapshot: LocalServiceLauncherSnapshotV1) => void;
}>;

describe('launcher start action helpers', () => {
    it.each(['accept', 'decline', 'retire'] as const)('joins canonical Setup consent before Service review and retains the original Start (%s)', async decision => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const cancellation = new AbortController();
        const target = { ...startableTarget, sessionId: undefined,
            workspace: { serverId: 'server-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/accepted' },
            declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest' as const, name: 'worker' } },
        };
        const choice = { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-a' } } as const;
        const setupEffect = { v: 1, purpose: 'setup', steps: [{ source: { kind: 'command', command: 'prepare' } }] };
        const setupDigest = 'a'.repeat(64);
        const serviceDigest = 'b'.repeat(64);
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const order: string[] = [];
        // Transport receipts and the person's Setup decision are boundaries. Both response readers,
        // admission lifetime and the original Start continuation remain real.
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            return { protocolVersion: 1, machineId: 'machine-a', targetId: target.id,
                snapshot: startedSnapshot, ...(requests.length === 1
                    ? { status: 'denied', reasonCode: 'project_setup_consent_required', reviewedEffect: setupEffect, reviewedEffectDigest: setupDigest }
                    : requests.length === 2
                        ? { status: 'denied', reasonCode: 'project_service_effect_review_required', reviewedEffect: { v: 1, purpose: 'service' }, reviewedEffectDigest: serviceDigest }
                        : { status: 'succeeded' }) };
        };
        const reviewSetupConsent = vi.fn(async (_review: unknown) => {
            order.push('setup');
            if (decision === 'retire') cancellation.abort();
            return decision !== 'decline';
        });
        const reviewEffect = vi.fn(async (_review: unknown) => { order.push('service'); return true; });
        const context = { runtimeActionExecute, serverId: 'server-a', expectedAccountId: 'initiating-account',
            signal: cancellation.signal, reviewSetupConsent, reviewEffect };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction(context));
        const result = await hook.getCurrent()!(target, choice);
        expect(reviewSetupConsent).toHaveBeenCalledWith(expect.objectContaining({ target,
            consent: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffect: setupEffect, reviewedEffectDigest: setupDigest } }));
        expect(requests).toHaveLength(decision === 'accept' ? 3 : 1);
        expect(order).toEqual(decision === 'accept' ? ['setup', 'service'] : ['setup']);
        if (decision === 'accept') {
            expect(requests[1]?.input).toEqual(requests[0]?.input);
            expect(requests[2]?.input).toMatchObject({ choice, expectedEffectDigest: serviceDigest });
            expect(result).toMatchObject({ status: 'succeeded' });
        }
        expect(requests.every(request => Reflect.get(request.context, 'expectedAccountId') === 'initiating-account')).toBe(true);
    });

    it('reads strict typed Setup failures before trying the Service response schema', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const consent = { kind: 'pendingApproval', code: 'project_setup_effect_changed', reviewedEffect: { v: 1, purpose: 'setup' }, reviewedEffectDigest: 'a'.repeat(64) } as const;
        const failure = { ok: false, errorCode: consent.code, error: consent.code, details: consent };
        const runtimeActionExecute = vi.fn<RuntimeActionExecute>(async () => failure);
        const reviewSetupConsent = vi.fn(async (_review: unknown) => false);
        const context = { runtimeActionExecute, reviewSetupConsent };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction(context));
        expect(await hook.getCurrent()!(startableTarget)).toBe(failure);
        expect(reviewSetupConsent).toHaveBeenCalledWith(expect.objectContaining({ consent }));
        expect(runtimeActionExecute).toHaveBeenCalledOnce();
    });

    it('rejects a Setup code without valid canonical review details', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const reviewSetupConsent = vi.fn(async (_review: unknown) => true);
        const runtimeActionExecute = vi.fn<RuntimeActionExecute>(async () => ({ ok: false,
            errorCode: 'project_setup_consent_required', error: 'project_setup_consent_required',
            details: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'unbound-digest' } }));
        const context = { runtimeActionExecute, reviewSetupConsent };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction(context));
        await hook.getCurrent()!(startableTarget);
        expect(reviewSetupConsent).not.toHaveBeenCalled();
        expect(runtimeActionExecute).toHaveBeenCalledOnce();
    });

    it('releases a held policy approval when the initiating Service scope retires', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const cancellation = new AbortController();
        const runtimeActionExecute: RuntimeActionExecute = async () => ({ kind: 'approval_request_created',
            artifactId: 'service-approval', actionId: 'localServices.launcher.start' });
        const onApprovalPending = vi.fn((_registration: ActionApprovalRegistration) => {});
        const context = { runtimeActionExecute, serverId: 'server-a', expectedAccountId: 'initiating-account',
            signal: cancellation.signal, onApprovalPending };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction(context));
        const pending = hook.getCurrent()!(startableTarget);
        await vi.waitFor(() => expect(onApprovalPending).toHaveBeenCalled());
        cancellation.abort();
        expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled' });
    });
    it('holds an Ask-first Start until its exact captured Account approval supplies the executed result', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            return { kind: 'approval_request_created', artifactId: 'service-approval', actionId: request.actionId };
        };
        let continuation: ActionApprovalContinuation | undefined;
        const onApprovalPending = (registration: ActionApprovalRegistration) => {
            if (typeof registration !== 'string') continuation = registration;
        };
        const applyLauncherSnapshot = vi.fn();
        const context = { runtimeActionExecute, serverId: 'server-a', expectedAccountId: 'initiating-account',
            onApprovalPending, applyLauncherSnapshot };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction(context));
        let settled = false;
        const pending = hook.getCurrent()!(startableTarget).then(result => { settled = true; return result; });
        await vi.waitFor(() => expect(continuation).toBeDefined());
        expect(settled).toBe(false);
        expect(applyLauncherSnapshot).not.toHaveBeenCalled();
        const result = { protocolVersion: 1, machineId: 'machine-a', targetId: startableTarget.id,
            status: 'succeeded', snapshot: startedSnapshot };
        // Stored approval receipt is the network/persistence boundary; header/body
        // matching, source binding and canonical output parsing remain real.
        const approval: ApprovalRequestV2 = { v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId: 'localServices.launcher.start',
            actionArgs: requests[0]!.input, summary: 'Start service', decision: { kind: 'approve', decidedAtMs: 2 },
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId: 'server-a', accountId: 'initiating-account', actionId: 'localServices.launcher.start', requestId: 'service-request' },
            execution: { executedAtMs: 2, ok: true, result } };
        expect(await continuation!.onExecuted({ id: 'service-approval', title: null,
            header: buildApprovalRequestArtifactHeaderV1(approval), body: JSON.stringify(approval),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true })).toBe('consumed');
        expect(await pending).toMatchObject({ status: 'succeeded' });
        expect(requests).toHaveLength(1);
        expect(applyLauncherSnapshot).toHaveBeenCalledWith(startedSnapshot);
    });
    it.each([true, false])('requires an explicit current-effect review before resubmitting a sessionless Start (accepted=%s)', async accepted => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const digest = 'a'.repeat(64);
        const target = { ...startableTarget, sessionId: undefined,
            workspace: { serverId: 'server-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/accepted' },
            declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest' as const, name: 'worker' } },
        };
        const reviewedEffect = { v: 1, purpose: 'service', declaration: target.declaration, command: { cwd: '.', source: { kind: 'command', command: 'worker' } } };
        const review = DaemonLocalServiceLauncherStartResponseV1Schema.parse({ protocolVersion: 1,
            machineId: 'machine-a', targetId: target.id, status: 'denied', reasonCode: 'project_service_effect_review_required',
            reviewedEffect, reviewedEffectDigest: digest, snapshot: startedSnapshot });
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        // Remote Action receipts and the person's explicit review are boundaries;
        // projection, response validation and resubmission remain real.
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            return requests.length === 1 ? review : { protocolVersion: 1, machineId: 'machine-a', targetId: target.id,
                status: 'succeeded', snapshot: startedSnapshot };
        };
        const reviewEffect = vi.fn(async (_review: unknown) => accepted);
        const context = { runtimeActionExecute, serverId: 'server-a', expectedAccountId: 'initiating-account', reviewEffect };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction(context));
        const result = await hook.getCurrent()?.(target);
        expect(reviewEffect).toHaveBeenCalledWith(expect.objectContaining({ target, reviewedEffect, reviewedEffectDigest: digest }));
        expect(requests).toHaveLength(accepted ? 2 : 1);
        expect(requests[0]?.input).not.toHaveProperty('expectedEffectDigest');
        expect(requests.every(request => Reflect.get(request.context, 'expectedAccountId') === 'initiating-account')).toBe(true);
        if (accepted) {
            expect(requests[1]?.input).toMatchObject({ workspace: target.workspace, declaration: target.declaration, expectedEffectDigest: digest });
            expect(requests[1]?.input).not.toHaveProperty('sessionId');
            expect(result).toMatchObject({ status: 'succeeded' });
        } else expect(result).not.toMatchObject({ status: 'succeeded' });
    });

    it('does not dispatch reviewed Start after its initiating scope is cancelled', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const cancellation = new AbortController();
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            return DaemonLocalServiceLauncherStartResponseV1Schema.parse({ protocolVersion: 1,
                machineId: 'machine-a', targetId: startableTarget.id, status: 'denied', reasonCode: 'project_service_effect_review_required',
                reviewedEffect: { v: 1, purpose: 'service' }, reviewedEffectDigest: 'a'.repeat(64), snapshot: startedSnapshot });
        };
        const reviewEffect = vi.fn(async () => { cancellation.abort(); return true; });
        const context = { runtimeActionExecute, serverId: 'server-a', signal: cancellation.signal, reviewEffect };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction(context));
        await hook.getCurrent()?.(startableTarget);
        expect(reviewEffect).toHaveBeenCalled();
        expect(requests).toHaveLength(1);
    });

    it('preserves the actual accepted Project address, declaration and reviewed digest without guessing from cwd', async () => {
        const { buildLocalServiceLauncherStartRequest } = await import('./launcherStartAction');
        const workspace = { serverId: 'server-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/accepted-root' };
        const declaration = { workspaceRefId: 'workspace-a', selection: { kind: 'native' as const,
            source: { kind: 'native' as const, tool: 'package_script' as const, file: 'web/package.json', target: 'dev' } } };
        const input = { target: { ...startableTarget, workspace, declaration, cwd: '/accepted-root/web' }, expectedEffectDigest: 'a'.repeat(64) };
        expect(buildLocalServiceLauncherStartRequest(input)).toMatchObject({ workspace, declaration, expectedEffectDigest: 'a'.repeat(64) });
    });

    it('sends a supported sessionless package through the launcher Action and retains its pending approval artifact', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const artifact = { ok: false, errorCode: 'approval_required', error: 'approval_required', details: { approval: { artifactId: 'approval-artifact' } } };
        const runtimeActionExecute = vi.fn(async () => artifact) satisfies RuntimeActionExecute;
        const workspace = { serverId: 'server-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/accepted-root' };
        const declaration = { workspaceRefId: 'workspace-a', selection: { kind: 'native' as const,
            source: { kind: 'native' as const, tool: 'package_script' as const, file: 'web/package.json', target: 'dev' } } };
        const target = { ...startableTarget, id: 'project-service:package', source: 'package_script' as const, sessionId: undefined,
            sourceClass: { kind: 'package_script' as const, runTargetId: 'project-service:package', packageName: 'web', scriptName: 'dev', cwd: '/accepted-root/web' },
            workspace, declaration, cwd: '/accepted-root/web' };
        const hook = await renderHook(() => useLocalServiceLauncherStartAction({ runtimeActionExecute, serverId: 'server-a', machineId: 'machine-a' }));
        const start = hook.getCurrent();
        expect(start).toBeTypeOf('function');
        // Call the public JS callback's optional review argument; the existing typed two-argument API remains supported.
        expect(await Reflect.apply(start!, undefined, [target, undefined, 'b'.repeat(64)])).toBe(artifact);
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({ actionId: 'localServices.launcher.start', input: {
            machineId: 'machine-a', targetId: 'project-service:package', workspaceId: 'workspace-a', workspace, declaration, expectedEffectDigest: 'b'.repeat(64),
        }, context: { serverId: 'server-a', surface: 'ui' } });
    });
    it('keeps unaccepted package suggestions inert and refuses a Project from another Home', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const runtimeActionExecute = vi.fn(async () => undefined) satisfies RuntimeActionExecute;
        const hook = await renderHook(() => useLocalServiceLauncherStartAction({ runtimeActionExecute, serverId: 'server-a', machineId: 'machine-a' }));
        const packageTarget = { ...startableTarget, source: 'package_script' as const,
            sourceClass: { kind: 'package_script' as const, runTargetId: 'legacy-package', packageName: 'web', scriptName: 'dev' } };
        expect(await hook.getCurrent()?.(packageTarget)).toBeUndefined();
        expect(await hook.getCurrent()?.({ ...startableTarget,
            workspace: { serverId: 'another-home', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/repo' },
            declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'web' } },
        })).toEqual({ ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' });
        expect(runtimeActionExecute).not.toHaveBeenCalled();
    });
    it('starts a qualified Project when its portable Home identity matches the saved profile', async () => {
        const { useLocalServiceLauncherStartAction } = await import('./launcherStartAction');
        const home = await upsertServerProfile({ serverUrl: 'https://service-start-alias.test', name: 'Service Home' });
        await setServerProfileIdentityForUrl(home.serverUrl, 'srv_service_start_home');
        try {
            expect(areServerProfileIdentifiersEquivalent(home.id, 'srv_service_start_home')).toBe(true);
            const requests: Parameters<RuntimeActionExecute>[0][] = [];
            const receipt = { ok: false, errorCode: 'approval_required', error: 'approval_required' };
            const runtimeActionExecute: RuntimeActionExecute = async request => { requests.push(request); return receipt; };
            const target = { ...startableTarget, sessionId: undefined,
                workspace: { serverId: 'srv_service_start_home', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/accepted' },
                declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest' as const, name: 'web' } },
            };
            const hook = await renderHook(() => useLocalServiceLauncherStartAction({ runtimeActionExecute, serverId: home.id }));
            expect(await hook.getCurrent()?.(target)).toBe(receipt);
            expect(requests[0]).toMatchObject({ actionId: 'localServices.launcher.start',
                input: { workspace: target.workspace, declaration: target.declaration }, context: { serverId: 'srv_service_start_home' } });
            expect(requests[0]?.input).not.toHaveProperty('sessionId');
        } finally { await removeServerProfile(home.id); }
    });

    it('keeps a reviewed enrolled-Machine choice on the ordinary launcher request', async () => {
        const { buildLocalServiceLauncherStartRequest } = await import('./launcherStartAction');
        const choice = { kind: 'workers', destination: { kind: 'machine', machineId: 'enrolled-worker' } } as const;
        expect(buildLocalServiceLauncherStartRequest({ target: startableTarget, choice }))
            .toMatchObject({ machineId: 'machine-a', targetId: 'managed:preview', choice });
    });

    it('builds the canonical launcher start runtime-action input', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.buildLocalServiceLauncherStartRequest).toBeTypeOf('function');
        if (!mod?.buildLocalServiceLauncherStartRequest) return;

        expect(mod.buildLocalServiceLauncherStartRequest({
            target: startableTarget,
            machineId: 'machine-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        })).toEqual({
            machineId: 'machine-a',
            targetId: 'managed:preview',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        });
    });

    it('executes launcher start through RuntimeActionExecute with the UI surface', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.useLocalServiceLauncherStartAction).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStartAction) return;

        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'succeeded',
            snapshot: startedSnapshot,
        })) satisfies RuntimeActionExecute;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStartAction({
            runtimeActionExecute,
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        }));
        const start = hook.getCurrent();

        expect(start).toBeTypeOf('function');
        await start?.(startableTarget);

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'managed:preview',
                sessionId: 'session-a',
                workspaceId: 'workspace-a',
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('applies successful launcher start response snapshots after RuntimeActionExecute returns', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.useLocalServiceLauncherStartAction).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStartAction) return;

        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'succeeded',
            snapshot: startedSnapshot,
        })) satisfies RuntimeActionExecute;
        const applyLauncherSnapshot = vi.fn();
        const useStartAction = mod.useLocalServiceLauncherStartAction as (
            context: StartActionContextWithSnapshotApply
        ) => ((target: LocalServiceLaunchTarget) => Promise<unknown>) | undefined;
        const hook = await renderHook(() => useStartAction({
            runtimeActionExecute,
            applyLauncherSnapshot,
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        }));
        const start = hook.getCurrent();

        expect(start).toBeTypeOf('function');
        await start?.(startableTarget);

        expect(applyLauncherSnapshot).toHaveBeenCalledExactlyOnceWith(startedSnapshot);
    });

    it('ignores denied, failed, disabled, malformed, and mismatched launcher start results for state refresh', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.readSuccessfulLocalServiceLauncherStartSnapshot).toBeTypeOf('function');
        if (!mod?.readSuccessfulLocalServiceLauncherStartSnapshot) return;

        const request = mod.buildLocalServiceLauncherStartRequest({
            target: startableTarget,
            machineId: 'machine-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        });
        const denied = {
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'denied',
            reasonCode: 'not_owned',
            snapshot: startedSnapshot,
        };
        const failed = {
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'failed',
            reasonCode: 'launch_failed',
            snapshot: startedSnapshot,
        };
        const disabled = {
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_launcher_unavailable',
        };
        const mismatchedSession = {
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'succeeded',
            snapshot: {
                ...startedSnapshot,
                sessionId: 'session-b',
            },
        };

        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(denied, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(failed, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(disabled, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot({ snapshot: startedSnapshot }, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(mismatchedSession, request)).toBeNull();
    });
});
