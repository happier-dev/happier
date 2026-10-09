import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isLocalServiceActionConfirmationNonceV1, LocalServiceActionRequestV1Schema, type RuntimeActionExecute } from '@happier-dev/protocol';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { areServerProfileIdentifiersEquivalent, removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import {
    buildDetectedLocalServiceTerminateRequest,
    buildLocalServiceCopyUrlRequest,
    createLocalServiceActionRequestId,
    useDetectedLocalServiceForgetAction,
    useDetectedLocalServiceTerminateAction,
    useLocalServiceCopyUrlAction,
    useManagedLocalServiceControlAction,
} from './lifecycleActions';

function managedCopyTarget(): LocalServiceLaunchTarget {
    return { id: 'logical-display-not-the-instance', source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'actual-owned-instance' },
        machineId: 'machine-a', workspaceId: ' accepted-workspace ',
        workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: ' accepted-workspace ', rootPath: '/accepted' },
        cwd: '/accepted/web', declaration: { workspaceRefId: ' accepted-workspace ', selection: { kind: 'manifest', name: ' web ' } },
        title: 'Web', confidence: 'high', state: 'available', serviceState: 'running', actions: ['manage'], endpointUrl: 'http://localhost:5173/' };
}

describe('local service lifecycle action helpers', () => {
    afterEach(() => { standardCleanup(); retirePresentationNotice(); });

    it.each(['accept', 'decline', 'retire'] as const)('joins Setup consent before Restart effect review without disrupting its occurrence (%s)', async decision => {
        const target = managedCopyTarget();
        const cancellation = new AbortController();
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const setupEffect = { v: 1, purpose: 'setup', steps: [{ source: { kind: 'command', command: 'prepare' } }] };
        const setupDigest = 'a'.repeat(64);
        const serviceDigest = 'b'.repeat(64);
        const order: string[] = [];
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            const parsed = LocalServiceActionRequestV1Schema.parse(request.input);
            return { v: 1, requestId: parsed.requestId, action: 'restart_managed', auditEvents: [],
                ...(requests.length === 1
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
        const context = { runtimeActionExecute, serverId: 'home-a', expectedAccountId: 'initiating-account',
            signal: cancellation.signal, reviewSetupConsent, reviewEffect };
        const hook = await renderHook(() => useManagedLocalServiceControlAction(context));
        const result = await hook.getCurrent()!(target, 'localServices.actions.restartManaged');
        expect(reviewSetupConsent).toHaveBeenCalledWith(expect.objectContaining({ target,
            consent: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffect: setupEffect, reviewedEffectDigest: setupDigest } }));
        expect(order).toEqual(decision === 'accept' ? ['setup', 'service'] : ['setup']);
        expect(requests).toHaveLength(decision === 'accept' ? 3 : 1);
        expect(requests.every(request => request.actionId === 'localServices.actions.restartManaged')).toBe(true);
        expect(target.serviceState).toBe('running');
        if (decision === 'accept') {
            expect(requests[1]?.input).toEqual(requests[0]?.input);
            const reviewedRequest = LocalServiceActionRequestV1Schema.parse(requests[2]!.input);
            expect(reviewedRequest).toMatchObject({ expectedEffectDigest: serviceDigest,
                target: LocalServiceActionRequestV1Schema.parse(requests[0]!.input).target });
            expect(isLocalServiceActionConfirmationNonceV1(reviewedRequest)).toBe(true);
            expect(result).toMatchObject({ status: 'succeeded' });
        }
    });

    it('reviews the current Restart effect before resubmitting the same qualified occurrence', async () => {
        const target = managedCopyTarget();
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const digest = 'a'.repeat(64);
        const reviewedEffect = { v: 1, purpose: 'service', declaration: target.declaration };
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            const parsed = LocalServiceActionRequestV1Schema.parse(request.input);
            return requests.length === 1
                ? { v: 1, requestId: parsed.requestId, action: 'restart_managed', status: 'denied',
                    reasonCode: 'project_service_effect_review_required', reviewedEffect, reviewedEffectDigest: digest, auditEvents: [] }
                : { v: 1, requestId: parsed.requestId, action: 'restart_managed', status: 'succeeded', auditEvents: [] };
        };
        const reviewEffect = vi.fn(async (_review: unknown) => true);
        const context = { runtimeActionExecute, serverId: 'home-a', expectedAccountId: 'initiating-account', reviewEffect };
        const hook = await renderHook(() => useManagedLocalServiceControlAction(context));
        const result = await hook.getCurrent()?.(target, 'localServices.actions.restartManaged');
        expect(reviewEffect).toHaveBeenCalledWith(expect.objectContaining({ target, reviewedEffect, reviewedEffectDigest: digest }));
        expect(requests).toHaveLength(2);
        const reviewedRequest = LocalServiceActionRequestV1Schema.parse(requests[1]!.input);
        expect(reviewedRequest).toMatchObject({ action: 'restart_managed', expectedEffectDigest: digest,
            target: LocalServiceActionRequestV1Schema.parse(requests[0]!.input).target });
        expect(isLocalServiceActionConfirmationNonceV1(reviewedRequest)).toBe(true);
        expect(requests.every(request => Reflect.get(request.context, 'expectedAccountId') === 'initiating-account')).toBe(true);
        expect(result).toMatchObject({ status: 'succeeded' });
    });

    it('projects managed Copy through its actual occurrence and exact declaration rather than display or Session identity', () => {
        const request = LocalServiceActionRequestV1Schema.parse(Reflect.apply(buildLocalServiceCopyUrlRequest, undefined,
            [{ target: managedCopyTarget(), requestId: 'copy-owned' }]));
        expect(request).toMatchObject({ action: 'copy_url', requestId: 'copy-owned', target: {
            kind: 'managed_service', managedServiceId: 'actual-owned-instance', machineId: 'machine-a',
            workspaceId: ' accepted-workspace ', cwd: '/accepted/web',
            declaration: { workspaceRefId: ' accepted-workspace ', selection: { kind: 'manifest', name: ' web ' } },
        } });
        expect(request.target).not.toHaveProperty('sessionId');
        expect(isLocalServiceActionConfirmationNonceV1(request)).toBe(true);
    });

    it('does not bypass a managed Copy refusal by writing the clipboard directly', async () => {
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        // The remote Machine Action receipt and OS clipboard are the boundaries;
        // exact request projection and the mounted hook remain real.
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            return { ok: false, errorCode: 'approval_required', error: 'approval_required', details: { artifactId: 'copy-approval' } };
        };
        const clipboard = vi.fn(async () => true);
        const hook = await renderHook(() => useLocalServiceCopyUrlAction({ runtimeActionExecute, copyToClipboard: clipboard,
            machineId: 'another-context-machine', sessionId: 'invoking-session', workspaceId: 'another-context-workspace', serverId: 'home-a' }));
        expect(await hook.getCurrent()(managedCopyTarget(), 'http://localhost:5173/')).toBe(false);
        expect(clipboard).not.toHaveBeenCalled();
        expect(requests[0]).toMatchObject({ actionId: 'localServices.actions.copyUrl',
            input: { target: { kind: 'managed_service', managedServiceId: 'actual-owned-instance', machineId: 'machine-a', workspaceId: ' accepted-workspace ', cwd: '/accepted/web' } },
            context: { serverId: 'home-a', defaultSessionId: 'invoking-session', surface: 'ui' } });
        expect(LocalServiceActionRequestV1Schema.parse(requests[0]!.input).target).not.toHaveProperty('sessionId');
    });

    it('hides a managed occurrence through Forget while retaining exact source and avoiding Stop', async () => {
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            return { v: 1, requestId: 'hidden', action: 'forget', status: 'succeeded', auditEvents: [] };
        };
        const hook = await renderHook(() => useDetectedLocalServiceForgetAction({ runtimeActionExecute,
            machineId: 'other-context-machine', sessionId: 'invoking-session', serverId: 'home-a' }));
        await expect(hook.getCurrent()?.(managedCopyTarget())).resolves.toMatchObject({ status: 'succeeded' });
        expect(requests.map(request => request.actionId)).toEqual(['localServices.actions.forget']);
        expect(LocalServiceActionRequestV1Schema.parse(requests[0]!.input)).toMatchObject({ action: 'forget', target: {
            kind: 'managed_service', managedServiceId: 'actual-owned-instance', machineId: 'machine-a',
            workspaceId: ' accepted-workspace ', cwd: '/accepted/web', declaration: managedCopyTarget().declaration,
        } });
        expect(LocalServiceActionRequestV1Schema.parse(requests[0]!.input).target).not.toHaveProperty('sessionId');
    });

    it('never copies a managed address when its audited Action transport is unavailable', async () => {
        const clipboard = vi.fn(async () => true);
        const hook = await renderHook(() => useLocalServiceCopyUrlAction({ copyToClipboard: clipboard }));
        expect(await hook.getCurrent()(managedCopyTarget(), 'http://localhost:5173/')).toBe(false);
        expect(clipboard).not.toHaveBeenCalled();
    });

    it('refuses managed controls and disclosure for a stale row from another Home', async () => {
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const runtimeActionExecute: RuntimeActionExecute = async request => { requests.push(request); return {}; };
        const clipboard = vi.fn(async () => true);
        const context = { runtimeActionExecute, serverId: 'home-b', machineId: 'machine-a' };
        const hook = await renderHook(() => ({
            copy: useLocalServiceCopyUrlAction({ ...context, copyToClipboard: clipboard }),
            forget: useDetectedLocalServiceForgetAction(context),
            control: useManagedLocalServiceControlAction(context),
        }));
        const target = managedCopyTarget();
        expect(await hook.getCurrent().copy(target, target.endpointUrl!)).toBe(false);
        await hook.getCurrent().forget?.(target);
        await hook.getCurrent().control?.(target, 'localServices.actions.stopManaged');
        expect(requests).toEqual([]);
        expect(clipboard).not.toHaveBeenCalled();
    });

    it('accepts the saved profile and portable identity of the same Home without losing source qualification', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://managed-service-alias.test', name: 'Service Home' });
        await setServerProfileIdentityForUrl(home.serverUrl, 'srv_managed_service_home');
        try {
            expect(areServerProfileIdentifiersEquivalent(home.id, 'srv_managed_service_home')).toBe(true);
            const requests: Parameters<RuntimeActionExecute>[0][] = [];
            const runtimeActionExecute: RuntimeActionExecute = async request => {
                requests.push(request);
                const parsed = LocalServiceActionRequestV1Schema.parse(request.input);
                return { v: 1, requestId: parsed.requestId, action: parsed.action, status: 'succeeded', auditEvents: [] };
            };
            const clipboard = vi.fn(async () => true);
            const context = { runtimeActionExecute, serverId: home.id };
            const hook = await renderHook(() => ({
                copy: useLocalServiceCopyUrlAction({ ...context, copyToClipboard: clipboard }),
                forget: useDetectedLocalServiceForgetAction(context),
                control: useManagedLocalServiceControlAction(context),
            }));
            const base = managedCopyTarget();
            const target = { ...base, workspace: { ...base.workspace!, serverId: 'srv_managed_service_home' } };
            expect(await hook.getCurrent().copy(target, target.endpointUrl!)).toBe(true);
            await hook.getCurrent().forget?.(target);
            await hook.getCurrent().control?.(target, 'localServices.actions.stopManaged');
            expect(requests.map(request => request.actionId)).toEqual(['localServices.actions.copyUrl', 'localServices.actions.forget', 'localServices.actions.stopManaged']);
            expect(requests.every(request => request.context.serverId === 'srv_managed_service_home')).toBe(true);
        } finally { await removeServerProfile(home.id); }
    });

    it('dispatches exact managed Stop and reviewed Restart without inventing a stopped state', async () => {
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const runtimeActionExecute: RuntimeActionExecute = async request => {
            requests.push(request);
            return { v: 1, requestId: 'unconfirmed', action: LocalServiceActionRequestV1Schema.parse(request.input).action,
                status: 'failed', reasonCode: 'native_stop_unconfirmed', auditEvents: [] };
        };
        const hook = await renderHook(() => useManagedLocalServiceControlAction({ runtimeActionExecute,
            machineId: 'ambient-machine', sessionId: 'invoking-session', serverId: 'home-a' }));
        const target = managedCopyTarget();
        await expect(hook.getCurrent()?.(target, 'localServices.actions.stopManaged')).resolves.toMatchObject({ status: 'failed', reasonCode: 'native_stop_unconfirmed' });
        await hook.getCurrent()?.(target, 'localServices.actions.restartManaged', { expectedEffectDigest: 'reviewed-current-effect' });
        expect(requests.map(request => request.actionId)).toEqual(['localServices.actions.stopManaged', 'localServices.actions.restartManaged']);
        for (const request of requests) {
            const parsed = LocalServiceActionRequestV1Schema.parse(request.input);
            expect(parsed.target).toMatchObject({ kind: 'managed_service', managedServiceId: 'actual-owned-instance', machineId: 'machine-a',
                workspaceId: ' accepted-workspace ', cwd: '/accepted/web', declaration: target.declaration });
            expect(parsed.target).not.toHaveProperty('sessionId');
            expect(isLocalServiceActionConfirmationNonceV1(parsed)).toBe(true);
        }
        expect(requests[1]!.input).toMatchObject({ action: 'restart_managed', expectedEffectDigest: 'reviewed-current-effect' });
        expect(target.serviceState).toBe('running');
    });

    it('refuses to derive executable inventory authority from a display id', async () => {
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        const runtimeActionExecute: RuntimeActionExecute = async request => { requests.push(request); return {}; };
        let terminate: ReturnType<typeof useDetectedLocalServiceTerminateAction>;
        function Harness() {
            terminate = useDetectedLocalServiceTerminateAction({ runtimeActionExecute, machineId: 'machine-a' });
            return React.createElement('View');
        }
        await renderScreen(React.createElement(Harness));
        const target: LocalServiceLaunchTarget = { id: 'inventory:wrong-entry', source: 'inventory_entry', title: 'Web',
            machineId: 'machine-a', confidence: 'high', state: 'available', actions: ['terminate_detected'] };
        await act(async () => { await terminate?.(target); });
        expect(requests).toEqual([]);
        await act(async () => { await terminate?.({ ...target, sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'real-entry' } }); });
        expect(requests[0]).toMatchObject({ input: { target: { inventoryEntryId: 'real-entry' } } });
    });

    it('offers Undo after a successful Forget and keeps its exact remote target after the row unmounts', async () => {
        const requests: Parameters<RuntimeActionExecute>[0][] = [];
        // Remote daemon Action receipts are the system boundary; the hook and notice owner stay real.
        const runtimeActionExecute: RuntimeActionExecute = async (request) => {
            requests.push(request);
            return { v: 1, requestId: 'receipt', action: 'forget', status: 'succeeded', auditEvents: [],
                ...(requests.length === 1 ? { undoKey: 'machine-a:tcp:loopback:127.0.0.1:5173' } : {}) };
        };
        let forget: ReturnType<typeof useDetectedLocalServiceForgetAction>;
        function Harness() {
            forget = useDetectedLocalServiceForgetAction({ runtimeActionExecute, machineId: 'machine-a', serverId: 'server-a' });
            return React.createElement('View');
        }
        const screen = await renderScreen(React.createElement(Harness));
        const target: LocalServiceLaunchTarget = {
            id: 'inventory:entry-a', source: 'inventory_entry', title: 'Web',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry-a' },
            machineId: 'machine-a', confidence: 'high', state: 'available', actions: [],
        };
        await act(async () => { await forget?.(target); });
        const notice = readPresentationNotice();
        expect(notice?.undo).toBeDefined();
        await act(async () => { screen.unmount(); });
        await act(async () => { await notice?.undo?.run(); });
        expect(requests[1]).toMatchObject({
            actionId: 'localServices.actions.forget',
            input: {
                action: 'forget', undoKey: 'machine-a:tcp:loopback:127.0.0.1:5173',
                target: { inventoryEntryId: 'machine-a:tcp:loopback:127.0.0.1:5173', machineId: 'machine-a' },
            },
            context: { serverId: 'server-a', surface: 'ui' },
        });
    });

    it('keeps a refused Undo visible through the notice owner', async () => {
        let requests = 0;
        const runtimeActionExecute: RuntimeActionExecute = async () => {
            requests += 1;
            return requests === 1
                ? { v: 1, requestId: 'forget', action: 'forget', status: 'succeeded', auditEvents: [], undoKey: 'suppression' }
                : { v: 1, requestId: 'undo', action: 'forget', status: 'denied', reasonCode: 'wrong_machine', auditEvents: [] };
        };
        let forget: ReturnType<typeof useDetectedLocalServiceForgetAction>;
        function Harness() {
            forget = useDetectedLocalServiceForgetAction({ runtimeActionExecute, machineId: 'machine-a' });
            return React.createElement('View');
        }
        await renderScreen(React.createElement(Harness));
        await act(async () => {
            await forget?.({ id: 'inventory:entry-a', source: 'inventory_entry', title: 'Web',
                sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry-a' },
                machineId: 'machine-a', confidence: 'high', state: 'available', actions: [] });
        });
        const notice = readPresentationNotice();
        await act(async () => { await notice?.undo?.run(); });
        const failure = readPresentationNotice();
        expect(failure?.severity).toBe('error');
        // The host retires the clicked notice, not the newer remote-failure notice.
        retirePresentationNotice(notice?.key);
        expect(readPresentationNotice()).toBe(failure);
    });

    it('generates bounded request ids for action correlation', () => {
        const first = createLocalServiceActionRequestId();
        const second = createLocalServiceActionRequestId();

        expect(first).toMatch(/^local-service-action-request:/);
        expect(second).toMatch(/^local-service-action-request:/);
        expect(first).not.toBe(second);
        expect(first.length).toBeLessThanOrEqual(256);
    });



    it('builds the canonical terminate-detected LocalServiceActionRequestV1 input', () => {
        const request = buildDetectedLocalServiceTerminateRequest({
            inventoryEntryId: 'inventory-entry-1',
            machineId: 'machine-a',
            sessionId: 'session-a',
            requestId: 'request-terminate',
        });

        expect(request).toEqual({
            requestId: 'request-terminate',
            target: {
                kind: 'inventory_entry',
                inventoryEntryId: 'inventory-entry-1',
                machineId: 'machine-a',
                sessionId: 'session-a',
            },
            action: 'terminate_detected',
            force: false,
            confirmationNonce: expect.stringMatching(/^lsact1_/),
        });
        expect(isLocalServiceActionConfirmationNonceV1(request)).toBe(true);
    });
});
