import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ActionApprovalRequestCreatedResultSchema, projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { LocalServiceNativePrerequisiteV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { bindServicesOpenInBrowser } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { createBrowserWorkspaceOpeningFixture } from '@/dev/testkit/fixtures/browserWorkspaceOpening';
import { createBrowserRuntimeActionExecutor } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { createLocalServicesRuntimeActionExecutor } from '@/sync/domains/local/services/actions/runtimeActionExecutor';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

const modalSpies = vi.hoisted(() => ({ alert: vi.fn() }));
const previewRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(previewRpc));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalSpies.alert } }).module;
});

import {
    readLocalServiceActionOutcome,
    describeLocalServiceActionFailure,
    presentLocalServiceActionFailure,
    useLocalServiceActionRunner,
} from './localServiceActionOutcome';

describe('readLocalServiceActionOutcome', () => {
    it.each(['approval_canceled', 'approval_rejected', 'cancelled'])('classifies the shared policy decline as cancelled (%s)', errorCode => {
        expect(readLocalServiceActionOutcome({ ok: false, errorCode, error: errorCode }))
            .toEqual({ kind: 'cancelled' });
    });
    it('retains a strict establishment cause for existing Details and rejects extra output fields', () => {
        const establishmentFailure = { cause: 'port_in_use', port: 5173, exitCode: 1,
            sameProject: true, lastStderrLine: 'Error: listen EADDRINUSE: address already in use :::5173' };
        const result = { status: 'denied', reasonCode: 'plugin_managed_service_establishment_failed', establishmentFailure };
        const outcome = readLocalServiceActionOutcome(result);
        expect(outcome).toEqual({ kind: 'failed', reasonCode: result.reasonCode, establishmentFailure });
        expect(readLocalServiceActionOutcome({ ...result, establishmentFailure: { ...establishmentFailure, stdout: 'private' } }))
            .toEqual({ kind: 'failed', reasonCode: result.reasonCode });
        if (outcome.kind !== 'failed') throw new Error('Missing failure');
        modalSpies.alert.mockClear();
        presentLocalServiceActionFailure({ title: 'Could not start', ...outcome });
        expect(modalSpies.alert.mock.calls[0]?.[1]).toContain('5173');
        expect(modalSpies.alert.mock.calls[0]?.[1]).toContain('project');
        const buttons = modalSpies.alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
        buttons.find(button => button.onPress)?.onPress?.();
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain(establishmentFailure.lastStderrLine);
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain('1');
    });
    it('retains only strict Docker prerequisite details for the failure presenter', () => {
        const prerequisite = LocalServiceNativePrerequisiteV1Schema.parse({ tool: 'docker', machineName: 'nl1', cause: 'permission_denied' });
        expect(readLocalServiceActionOutcome({ status: 'denied', reasonCode: 'native_tool_unavailable', prerequisite }))
            .toEqual({ kind: 'failed', reasonCode: 'native_tool_unavailable', prerequisite });
        expect(readLocalServiceActionOutcome({ status: 'denied', reasonCode: 'native_tool_unavailable',
            prerequisite: { ...prerequisite, stderr: 'private native output' } }))
            .toEqual({ kind: 'failed', reasonCode: 'native_tool_unavailable' });
    });
    it('retains the local-services refusal detail instead of its generic Action wrapper', () => {
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_inventory_request_failed' }))
            .toEqual({ kind: 'failed', reasonCode: 'local_services_inventory_request_failed' });
        expect(readLocalServiceActionOutcome(new RpcError('private transport detail', RPC_ERROR_CODES.FORBIDDEN)))
            .toEqual({ kind: 'failed', reasonCode: RPC_ERROR_CODES.FORBIDDEN });
    });
    it('retains only a code-shaped Browser refusal detail, never arbitrary transport prose', () => {
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_adapter_unavailable' }))
            .toEqual({ kind: 'failed', reasonCode: 'browser_adapter_unavailable' });
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:private transport detail' }))
            .toEqual({ kind: 'failed', reasonCode: 'runtime_action_disabled' });
    });
    it.each([
        ['localServices', 'local_services_preview_refused:preview_target_unresolved', 'preview_target_unresolved'],
        ['localServices', 'local_services_preview_refused:unknown_managed_service', 'unknown_managed_service'],
        ['localServices', 'local_services_preview_refused:requester_credentials_unavailable', 'requester_credentials_unavailable'],
        ['browser', 'browser_adapter_unavailable', 'browser_adapter_unavailable'],
        ['browser', 'browser_view_unavailable', 'browser_view_unavailable'],
    ])('keeps the Action-wrapped %s/%s refusal named without changing its diagnostic code', (family, wrappedCode, reasonCode) => {
        const outcome = readLocalServiceActionOutcome({ ok: false, errorCode: 'runtime_action_disabled',
            error: `runtime_action_disabled:${family}:${wrappedCode}` });
        expect(outcome).toEqual({ kind: 'failed', reasonCode });
        if (outcome.kind !== 'failed') throw new Error('Expected a refusal');
        const failure = describeLocalServiceActionFailure({ ...outcome, serviceName: 'Reading desk' });
        expect(failure.details).toContain(reasonCode);
        expect(failure.body).toContain('Reading desk');
        expect(failure.body).not.toContain(reasonCode);
        expect(failure.body).not.toContain(resolveReasonCopy({ reasonCode: null, kind: 'localServiceAction' }).body);
    });
    it('says the Service once: a title that names it is not repeated in the body, and a missing in-app browser view is a failure, not a refusal', () => {
        const input = { reasonCode: 'browser_view_unavailable', serviceName: 'Lumen web' };
        const named = describeLocalServiceActionFailure({ ...input, title: 'Could not open Lumen web' });
        expect(named.body).not.toContain('Lumen web');
        expect(named.refusal).toBe(false);
        expect(describeLocalServiceActionFailure({ ...input, title: 'Open again' }).body).toContain('Lumen web');
        expect(describeLocalServiceActionFailure({ reasonCode: 'permission_denied' }).refusal).toBe(true);
    });
    it('keeps a real Ask-first receipt pending rather than reporting a successful mutation', () => {
        const receipt = ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            artifactId: 'service-approval', actionId: 'localServices.launcher.start' });
        expect(readLocalServiceActionOutcome(receipt)).toEqual({ kind: 'approval_pending',
            artifactId: receipt.artifactId, actionId: receipt.actionId });
        expect(readLocalServiceActionOutcome(false)).toEqual({ kind: 'failed', reasonCode: null });
    });
    it('classifies every failure shape the corridor can actually produce', () => {
        // A guard that never dispatched: no daemon code, still a failure the user must see.
        expect(readLocalServiceActionOutcome(undefined)).toEqual({ kind: 'failed', reasonCode: null });
        // The action-executor front door refusing before the daemon saw it.
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'permission_denied' }))
            .toEqual({ kind: 'failed', reasonCode: 'permission_denied' });
        // The daemon refusing, or trying and failing.
        expect(readLocalServiceActionOutcome({ status: 'denied', reasonCode: 'policy_forbids_action' }))
            .toEqual({ kind: 'failed', reasonCode: 'policy_forbids_action' });
        expect(readLocalServiceActionOutcome({ status: 'failed', reasonCode: 'executor_failed' }))
            .toEqual({ kind: 'failed', reasonCode: 'executor_failed' });
    });

    it('does not mistake a success payload for a failure', () => {
        expect(readLocalServiceActionOutcome({ status: 'succeeded' })).toEqual({ kind: 'succeeded' });
        // A launch handler that resolves the opened target, with no envelope at all.
        expect(readLocalServiceActionOutcome({ exposureId: 'exposure-a' })).toEqual({ kind: 'succeeded' });
        expect(readLocalServiceActionOutcome(true)).toEqual({ kind: 'succeeded' });
    });
});

function renderRunner() {
    const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
    function Harness() {
        value.current = useLocalServiceActionRunner();
        return React.createElement('View');
    }
    return { value, Harness };
}

describe('useLocalServiceActionRunner', () => {
    afterEach(standardCleanup);
    beforeEach(() => modalSpies.alert.mockReset());

    it('retains an accepted native operation without announcing a completed service mutation', async () => {
        const receipt = { kind: 'accepted', operation: { operationId: 'native-stop-operation' } };
        expect(readLocalServiceActionOutcome(receipt)).toEqual({ kind: 'accepted',
            operationId: receipt.operation.operationId });
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        await act(async () => {
            expect(await value.current?.run({ id: 'stop', failureTitle: 'Could not stop',
                action: async () => receipt })).toBe(false);
        });
        expect(value.current?.failure).toBeNull();
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('keeps a failed Service start typed, named and recoverable through the real Open outcome owner', async () => {
        previewRpc.mockReset();
        previewRpc.mockRejectedValue(new Error('local_service_preview_lifecycle_refused:preview_registration_failed'));
        const target = LocalServiceLaunchTargetV1Schema.parse({
            id: 'managed:lumen', source: 'managed_service', machineId: 'machine', title: 'Lumen web',
            sourceClass: { kind: 'managed_service', managedServiceId: 'lumen' },
            cwd: '/repo', declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } },
            serviceState: 'failed', confidence: 'high', state: 'available', actions: ['manage'],
            diagnostics: [{ code: 'native_service_output', severity: 'info', message: 'Address already in use' }],
        });
        const openTarget = vi.fn();
        const open = bindServicesOpenInBrowser({ platform: 'web', onOpenTarget: openTarget });
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness() { value.current = useLocalServiceActionRunner({ presentation: 'inline', servicesActionOffered: true }); return null; }
        await renderScreen(<Harness />);
        await act(async () => {
            expect(await value.current?.run({ id: 'open-again', failureTitle: 'Open again', serviceName: target.title,
                serviceTarget: target, action: () => open(target) })).toBe(false);
        });
        expect(value.current?.failure).toMatchObject({
            reasonCode: 'plugin_managed_service_establishment_failed',
            title: 'Service couldn’t start', body: 'Lumen web stopped before it was ready.',
            recovery: { kind: 'reviewOutput', label: 'Review output', lines: ['Address already in use'] },
        });
        expect(value.current?.failure?.body).not.toContain('Review output');
        // A known failed start neither registers another preview nor opens another tab or retries.
        expect(previewRpc).not.toHaveBeenCalled();
        expect(openTarget).not.toHaveBeenCalled();
        expect(value.current?.pendingId).toBeNull();
    });

    it('presents a typed startup failure before its feed arrives and keeps structured output in Details', async () => {
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness() { value.current = useLocalServiceActionRunner({ presentation: 'inline', servicesActionOffered: true }); return null; }
        await renderScreen(<Harness />);
        const serviceTarget = LocalServiceLaunchTargetV1Schema.parse({
            id: 'managed:lumen', source: 'managed_service', machineId: 'machine', title: 'Lumen web',
            sourceClass: { kind: 'managed_service', managedServiceId: 'lumen' },
            serviceState: 'running', confidence: 'high', state: 'available', actions: ['manage'],
        });
        const establishmentFailure = { cause: 'process_exited' as const, exitCode: 1, lastStderrLine: 'Unable to bind listener' };
        await act(async () => {
            expect(await value.current?.run({ id: 'open-again', failureTitle: 'Open again', serviceName: 'Lumen web', serviceTarget,
                action: async () => ({ status: 'failed', reasonCode: 'plugin_managed_service_establishment_failed', establishmentFailure }) })).toBe(false);
        });
        expect(value.current?.failure).toMatchObject({
            reasonCode: 'plugin_managed_service_establishment_failed',
            title: 'Service couldn’t start', body: 'Lumen web stopped before it was ready.',
            details: ['Exit code 1', 'Unable to bind listener', 'plugin_managed_service_establishment_failed'],
        });
        expect(value.current?.pendingId).toBeNull();
        expect(modalSpies.alert).not.toHaveBeenCalled();
        // The plain headline must not discard a known port conflict's actionable detail.
        const portFailure = { cause: 'port_in_use' as const, port: 5173, sameProject: true };
        await act(async () => {
            await value.current?.run({ id: 'open-again', failureTitle: 'Open again', serviceName: 'Lumen web', serviceTarget,
                action: async () => ({ status: 'failed', reasonCode: 'plugin_managed_service_establishment_failed', establishmentFailure: portFailure }) });
        });
        expect(value.current?.failure?.body).toBe('Lumen web stopped before it was ready.');
        expect(value.current?.failure?.details).toContain(resolveReasonCopy({ kind: 'localServiceAction',
            reasonCode: 'plugin_managed_service_establishment_failed', establishmentFailure: portFailure }).body);
    });

    it('does not settle an unknown Stop from the binding that was already running', async () => {
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness() {
            value.current = useLocalServiceActionRunner({ presentation: 'inline', observedNativeBinding: true });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => { await value.current?.run({ id: 'stop', failureTitle: 'Could not stop',
            action: async () => projectUnexpectedActionFailureV1(null) }); });
        expect(value.current?.failure?.reasonCode).toBe('action_outcome_unknown');
        expect(value.current?.failure?.retry).toBeNull();
    });

    it.each(['approval_canceled', 'approval_rejected', 'cancelled'])('clears pending without success or failure presentation when shared policy is declined (%s)', async errorCode => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        await act(async () => {
            expect(await value.current?.run({ id: 'row:declined', failureTitle: 'Could not stop',
                action: async () => ({ ok: false, errorCode, error: errorCode }) })).toBe(false);
        });
        expect(value.current?.pendingId).toBeNull();
        expect(value.current?.failure).toBeNull();
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it.each(['not_installed', 'not_running', 'permission_denied', 'unavailable'])('shows the named machine and Docker prerequisite through the existing failure dialog (%s)', async cause => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        await act(async () => {
            expect(await value.current?.run({ id: 'docker', failureTitle: 'Could not start api',
                action: async () => ({ status: 'denied', reasonCode: 'native_tool_unavailable',
                    prerequisite: LocalServiceNativePrerequisiteV1Schema.parse({ tool: 'docker', machineName: 'nl1', cause }) }) })).toBe(false);
        });
        const body = String(modalSpies.alert.mock.calls[0]?.[1]);
        expect(body).toContain('nl1');
        expect(body).toContain('Docker');
        if (cause !== 'unavailable') expect(body).not.toContain(cause);
        const buttons = modalSpies.alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
        buttons.find(button => button.onPress)?.onPress?.();
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain('native_tool_unavailable');
    });

    it('keeps an inline failure for the owner to render instead of opening a dialog, until the next run or a dismissal', async () => {
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness() { value.current = useLocalServiceActionRunner({ presentation: 'inline' }); return React.createElement('View'); }
        await renderScreen(<Harness />);
        const action = vi.fn(async () => ({ status: 'denied', reasonCode: 'native_tool_unavailable',
            prerequisite: LocalServiceNativePrerequisiteV1Schema.parse({ tool: 'docker', machineName: 'nl1', cause: 'permission_denied' }) }));
        await act(async () => { await value.current?.run({ id: 'row:inline', failureTitle: 'Could not start api', action }); });
        expect(modalSpies.alert).not.toHaveBeenCalled();
        expect(value.current?.failure).toMatchObject({ title: 'Could not start api', reasonCode: 'native_tool_unavailable' });
        expect(value.current?.failure?.body).toContain('Docker');
        expect(value.current?.failure?.details).toContain('native_tool_unavailable');
        await act(async () => { value.current?.failure?.retry?.(); });
        expect(action).toHaveBeenCalledTimes(2);
        expect(value.current?.failure).not.toBeNull();
        await act(async () => { value.current?.dismissFailure(); });
        expect(value.current?.failure).toBeNull();
        await act(async () => { await value.current?.run({ id: 'row:inline', failureTitle: 'Could not start api', action: async () => ({ status: 'succeeded' }) }); });
        expect(value.current?.failure).toBeNull();
    });

    it('does not trigger success affordances or a failure alert for a pending policy approval', async () => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({ id: 'row:approval', failureTitle: 'Could not start',
                action: async () => ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
                    artifactId: 'service-approval', actionId: 'localServices.launcher.start' }) });
        });
        expect(outcome).toBe(false);
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('clears the in-flight row through the StrictMode effect replay', async () => {
        // The row spinner is driven by `pendingId`. A mounted-guard that is only ever set to
        // `false` in cleanup never recovers from React's development effect replay, so the row
        // would stay busy forever after an action the user actually completed.
        const { value, Harness } = renderRunner();
        await renderScreen(<React.StrictMode><Harness /></React.StrictMode>);

        let settle!: (result: unknown) => void;
        const dispatched = new Promise<unknown>((resolve) => { settle = resolve; });
        let pending!: Promise<boolean>;
        await act(async () => {
            pending = value.current!.run({
                id: 'row-a:menu',
                failureTitle: 'Could not terminate Vite',
                action: () => dispatched,
            });
            await Promise.resolve();
        });
        expect(value.current?.pendingId).toBe('row-a:menu');

        await act(async () => {
            settle({ status: 'succeeded' });
            await pending;
        });
        expect(value.current?.pendingId).toBeNull();
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('shows one actionable failure and resolves false when the action is refused', async () => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);

        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({
                id: 'row-a:inline',
                failureTitle: 'Could not start Vite',
                action: async () => ({ status: 'denied', reasonCode: 'policy_forbids_action' }),
            });
        });

        expect(outcome).toBe(false);
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        const [title, body] = modalSpies.alert.mock.calls[0] ?? [];
        expect(title).toBe('Could not start Vite');
        // Failure copy remains readable; diagnostic enum codes do not appear in the primary body.
        expect(typeof body).toBe('string');
        expect(String(body).length).toBeGreaterThan(0);
        expect(String(body)).not.toContain('policy_forbids_action');
        const buttons = modalSpies.alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
        buttons.find(button => button.onPress)?.onPress?.();
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain('policy_forbids_action');
        expect(value.current?.pendingId).toBeNull();
    });

    it.each(['service_not_listening', 'preview_unknown_managed_service'])('names the stopped Service and its recovery for %s', async reasonCode => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        await act(async () => {
            await value.current?.run({ id: 'open-again', failureTitle: 'Open again', serviceName: 'Reading desk',
                action: async () => ({ status: 'denied', reasonCode }) });
        });
        const body = modalSpies.alert.mock.calls[0]?.[1];
        expect(body).toContain('Reading desk');
        expect(body).toContain('Services');
        expect(body).not.toContain(reasonCode);
        expect(value.current?.pendingId).toBeNull();
    });

    it('reprojects a retained refusal when the offered Services action changes', async () => {
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness({ servicesActionOffered }: { servicesActionOffered: boolean }) {
            value.current = useLocalServiceActionRunner({ presentation: 'inline', servicesActionOffered });
            return null;
        }
        const screen = await renderScreen(<Harness servicesActionOffered={false} />);
        const action = vi.fn(async () => ({ status: 'denied', reasonCode: 'preview_registration_failed' }));
        await act(async () => {
            await value.current?.run({ id: 'open-again', failureTitle: 'Open again', serviceName: 'Reading desk', action });
        });
        expect(value.current?.failure?.body).toContain('Services');
        await screen.update(<Harness servicesActionOffered />);
        expect(value.current?.failure?.body).toBe('Reading desk: The preview could not be opened.');
        expect(value.current?.failure?.reasonCode).toBe('preview_registration_failed');
        expect(value.current?.failure?.details).toContain('preview_registration_failed');
        await screen.update(<Harness servicesActionOffered={false} />);
        expect(value.current?.failure?.body).toContain('Services');
        expect(action).toHaveBeenCalledTimes(1);
    });

    it.each([
        'preview_target_unresolved', 'unknown_managed_service', 'service_not_listening',
        'requester_credentials_unavailable', 'wrong_machine', 'preview_session_mismatch',
        'inventory_unavailable', 'unknown_inventory_entry', 'endpoint_scheme_unknown',
        'non_loopback_target', 'preview_account_unavailable', 'preview_server_unavailable',
        'invalid_resource', 'preview_registration_failed',
        'preview_runtime_unavailable', 'invalid_preview_resource', 'session_not_authorized',
        'preview_token_secret_missing', 'preview_public_base_url_missing', 'preview_hostname_collision',
    ])('keeps the Open again refusal typed and Service-named through the real outcome owner (%s)', async reasonCode => {
        previewRpc.mockReset();
        previewRpc.mockRejectedValue(new Error(`local_service_preview_lifecycle_refused:${reasonCode}`));
        const managedTarget = LocalServiceLaunchTargetV1Schema.parse({
            id: 'managed:reading-desk', source: 'managed_service', machineId: 'machine', title: 'Reading desk',
            sourceClass: { kind: 'managed_service', managedServiceId: 'reading-desk' },
            workspaceId: 'checkout', cwd: '/repo', declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } },
            confidence: 'high', state: 'available', actions: ['register_preview'],
        });
        // Use the real request intent that can receive each refusal: inventory
        // observation, retained Session registration, or exact Project custody.
        const target = LocalServiceLaunchTargetV1Schema.parse([
            'inventory_unavailable', 'unknown_inventory_entry', 'endpoint_scheme_unknown',
            'non_loopback_target', 'preview_account_unavailable',
        ].includes(reasonCode) ? {
            ...managedTarget, id: 'inventory:reading-desk', source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'reading-desk' },
            declaration: undefined, cwd: undefined,
        } : reasonCode === 'preview_session_mismatch' ? {
            ...managedTarget, sessionId: 'session', browserTarget: {
                kind: 'localServicePreview', targetId: 'reading-desk', machineId: 'machine', sessionId: 'session',
            },
        } : managedTarget);
        const fixture = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web', openDetailsTab: () => {} }, {
            runtimeActionExecute: createLocalServicesRuntimeActionExecutor({ fallback: createBrowserRuntimeActionExecutor({}) }),
        });
        const deps = { platform: 'web' as const, serverId: fixture.context.serverId,
            onOpenTarget: () => { throw new Error('A refused preview must not open a tab'); },
            actionExecute: (...args: Parameters<typeof fixture.executor.execute>) => fixture.executor.execute(args[0], args[1],
                { ...args[2], ...fixture.context }) };
        const openAgain = bindServicesOpenInBrowser(deps);
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness() { value.current = useLocalServiceActionRunner({ presentation: 'inline' }); return null; }
        await renderScreen(<Harness />);
        await act(async () => {
            expect(await value.current?.run({ id: 'open-again', failureTitle: 'Open again', serviceName: target.title,
                action: () => openAgain(target) })).toBe(false);
        });
        expect(value.current?.failure?.reasonCode).toBe(reasonCode);
        expect(value.current?.failure?.details).toContain(reasonCode);
        expect(value.current?.failure?.body).toContain(target.title);
        expect(value.current?.failure?.body).not.toContain(reasonCode);
        expect(value.current?.failure?.body).not.toContain(resolveReasonCopy({ reasonCode: null, kind: 'localServiceAction' }).body);
        if (reasonCode === 'preview_target_unresolved') {
            expect(value.current?.failure?.body).toContain(t('localServices.actions.failure.previewNotReady', {}));
            expect(value.current?.failure?.body).toContain('Services');
        }
        expect(value.current?.pendingId).toBeNull();
        // A refusal settles once; the owner does not automatically repeat admission.
        expect(previewRpc).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert).not.toHaveBeenCalled();
        fixture.dispose();
    });

    it.each([
        new RpcError('private transport detail', RPC_ERROR_CODES.FORBIDDEN),
        'private transport detail',
        { code: RPC_ERROR_CODES.FORBIDDEN, message: 'private transport detail' },
    ])('treats a thrown transport error as the same visible failure as a returned refusal (%s)', async error => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);

        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({
                id: 'row-a:inline',
                failureTitle: 'Could not open Vite',
                action: async () => { throw error; },
            });
        });

        expect(outcome).toBe(false);
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert.mock.calls[0]?.[1]).not.toContain(RPC_ERROR_CODES.FORBIDDEN);
        expect(modalSpies.alert.mock.calls[0]?.[1]).not.toContain('private transport detail');
        expect(value.current?.pendingId).toBeNull();
    });
});
