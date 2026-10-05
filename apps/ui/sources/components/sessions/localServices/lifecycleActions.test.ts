import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { isLocalServiceActionConfirmationNonceV1, type RuntimeActionExecute } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

import {
    buildDetectedLocalServiceTerminateRequest,
    createLocalServiceActionRequestId,
    useDetectedLocalServiceForgetAction,
    useDetectedLocalServiceTerminateAction,
} from './lifecycleActions';

describe('local service lifecycle action helpers', () => {
    afterEach(() => { standardCleanup(); retirePresentationNotice(); });

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
