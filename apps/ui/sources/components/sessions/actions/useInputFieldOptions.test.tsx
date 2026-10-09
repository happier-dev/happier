import * as React from 'react';
import { Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

// Hoist the physical transport before cross-package imports can capture Socket.IO.
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const rpc = vi.hoisted(() => ({ read: vi.fn() }));
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
        if (event !== 'rpc-call') throw new Error(`Unexpected options transport event: ${event}`);
        // Socket.IO supplies an untyped payload; assertions inspect its published wire shape.
        const request = payload as SocketRpcRequestPayload;
        const carrier = socket as unknown as { io: { uri: string }; auth: { token?: string } };
        return { ok: true, result: await rpc.read({ serverUrl: carrier.io.uri, token: carrier.auth.token, request }) };
    });
});
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useInputFieldOptions } = await import('./useInputFieldOptions');
const { scopedHomeActionExecutor, resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { repositoryInputTypeRef } = await import('../../../../../../packages/plugin-sdk/examples/public-authoring/inputTypes');
let disposeModuleLoader: (() => void) | undefined;
beforeEach(async () => { await harness.reset(); rpc.read.mockReset(); resetScopedHomeActionExecutorsForTests();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    // The scoped socket's authenticated readiness probe uses the raw network boundary,
    // distinct from the Home harness's scoped Action/row request adapters.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        const home = harness.findByServerUrl(url.origin);
        if (url.pathname !== '/v1/auth/ping' || !home) throw new Error(`Unexpected options readiness request: ${url.href}`);
        return Response.json(new Headers(init?.headers).get('Authorization') === `Bearer ${home.token}` ? { ok: true } : { error: 'unauthorized' },
            { status: new Headers(init?.headers).get('Authorization') === `Bearer ${home.token}` ? 200 : 401 });
    });
    disposeModuleLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
    standardCleanup(); disposeModuleLoader?.(); disposeModuleLoader = undefined;
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
});
const field = { path: 'repository', inputType: repositoryInputTypeRef };

function OptionsProbe(props: Readonly<{ serverId: string; workflow: string }>) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const options = useInputFieldOptions({ serverId: props.serverId, machineId: 'controller-a', enabled: !!binding, accountLifetime: binding,
        requests: [{ field, consumer: { kind: 'workflow', workflow: props.workflow }, draftInput: {} }] });
    const state = options.state(field);
    return <View testID="native-field.options" accessibilityLabel={state.status} accessibilityHint={state.errorCode}>
        {state.options.map(option => <Text key={option.label}>{option.label}</Text>)}
    </View>;
}

async function createTypedWorkflow(serverId: string, accountId: string, definitionId = '00000000-0000-4000-8000-000000000051') {
    const machine = createPlainMachineRowFixture({ id: 'controller-a', accountId });
    harness.answer(serverId, 'GET /v1/machines/controller-a', { body: { machine } });
    harness.answer(serverId, 'GET /v1/machines', { body: [machine] });
    const result = await scopedHomeActionExecutor({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId })('workflow.definition.create', {
        definitionId, definition: { version: 1, inputs: [{ name: 'repository', valueType: 'json', required: true, inputType: repositoryInputTypeRef }],
            defaults: {}, blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        metadata: { title: 'Input fixture' },
    }, { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
    expect(result.ok).toBe(true);
    expect(harness.artifacts(serverId).list()).toHaveLength(1);
    return definitionId;
}
function reply(label: string) {
    return { actionId: 'workflow.run.start', fieldPath: field.path,
        optionsSourceId: `plugin-input:${repositoryInputTypeRef.pluginId}/${repositoryInputTypeRef.localId}`,
        options: [{ value: { repositoryId: 'example/review-assistant' }, label }] };
}

describe('qualified input field options scope', () => {
    it('withdraws a retired target Account response and resolves only the replacement binding', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://retired-options.example', serverIdentityId: 'srv_retired_options', accountId: 'original-owner' });
        await harness.addHome({ name: 'Focused', serverUrl: 'https://other-options.example', serverIdentityId: 'srv_other_options', accountId: 'focused-owner', currentAccount: true });
        const workflow = await createTypedWorkflow(target, 'original-owner');
        let releaseOriginal: (() => void) | undefined;
        let first = true;
        rpc.read.mockImplementation(async () => {
            const original = first; first = false;
            if (original) await new Promise<void>(resolve => { releaseOriginal = resolve; });
            return reply(original ? 'Retired repository' : 'Replacement repository');
        });
        const screen = await renderScreen(<OptionsProbe serverId={target} workflow={workflow} />);
        await waitForHomeGovernance(() => expect(rpc.read.mock.calls.length > 0
            || screen.findByTestId('native-field.options')?.props.accessibilityLabel === 'failed').toBe(true));
        expect(rpc.read).toHaveBeenCalledTimes(1);
        await act(async () => harness.switchAccount(target, 'replacement-owner'));
        // The replacement Account has its own authored definition, not the retired Account's content.
        harness.artifacts(target).clear();
        const replacement = await createTypedWorkflow(target, 'replacement-owner', '00000000-0000-4000-8000-000000000052');
        await screen.update(<OptionsProbe serverId={target} workflow={replacement} />);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Replacement repository'));
        await act(async () => { releaseOriginal?.(); await flushHookEffects(); });
        expect(screen.getTextContent()).not.toContain('Retired repository');
        expect(screen.getTextContent()).toContain('Replacement repository');
        await screen.unmount();
    });
    it('resolves a declared native input type in the captured target Home instead of borrowing the focused Account', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute-options.example', serverIdentityId: 'srv_compute_options', accountId: 'compute-owner' });
        await harness.addHome({ name: 'Focused', serverUrl: 'https://focused-options.example', serverIdentityId: 'srv_focused_options', accountId: 'focused-owner', currentAccount: true });
        const workflow = await createTypedWorkflow(target, 'compute-owner');
        rpc.read.mockResolvedValue(reply('Target repository'));
        const screen = await renderScreen(<OptionsProbe serverId={target} workflow={workflow} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('native-field.options')?.props.accessibilityLabel).not.toBe('loading'));
        expect({ status: screen.findByTestId('native-field.options')?.props.accessibilityLabel,
            code: screen.findByTestId('native-field.options')?.props.accessibilityHint }).toEqual({ status: 'ready', code: undefined });
        expect(screen.getTextContent()).toContain('Target repository');
        expect(rpc.read).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: expect.stringContaining('compute-options.example'),
            token: createAccountTokenForTests('compute-owner'), request: expect.objectContaining({ method: 'controller-a:action.options.resolve', params: {
                v: 1, kind: 'targeted_action_rpc', target: { kind: 'machine', machineId: 'controller-a' },
                input: { consumer: { kind: 'workflow', workflow }, fieldPath: field.path, draftInput: { machineId: 'controller-a' } },
            } }) }));
        await screen.unmount();
    });
});
