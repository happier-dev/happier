import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { Switch } from '@/components/ui/forms/Switch';
import { WalkthroughSavedSettings } from './WalkthroughSavedSettings';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { upsertServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

const boundary = vi.hoisted(() => ({
    list: async (_machineId: string): Promise<unknown> => { throw new Error('Owning machine unavailable'); },
}));

// Device custody and the remote machine are external; binding, schemas and saved operations stay real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'saved-account' })).toString('base64')}.signature`, secret: 'fixture-secret' }),
    } });
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { machineId: string; method: string }) => {
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) return boundary.list(request.machineId);
        throw new Error(`Unexpected machine method: ${request.method}`);
    };
    // Method-specific wire answers at the external generic RPC boundary.
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});

// Native rendering adapters only; the settings store and credential binding remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const icons = createExpoVectorIconsMock();
    return { default: icons.Ionicons, Ionicons: icons.Ionicons };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

afterEach(() => standardCleanup());

describe('Prepare walkthrough preference', () => {
    it('hides Clear only after the owning machine confirms an empty saved inventory', async () => {
        const empty = createDeferred<unknown>();
        const listed = { success: true, results: [{ cwd: '/repo', resultId: 'saved', revision: 1,
            comparisonId: 'comparison', source: { kind: 'workingTree' }, bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        boundary.list = async machineId => {
            if (machineId === 'empty') return empty.promise;
            if (machineId === 'populated') return listed;
            throw new Error('Owning machine offline');
        };
        const home = await upsertServerProfile({ name: 'Saved Settings', serverUrl: 'https://saved-settings.example.test' });
        await setActiveServerId(home.id, { scope: 'device' });
        const view = (machineId: string) => <WalkthroughSavedSettings machineId={machineId} serverId={home.id} machineName="Computer"
            prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable={false} />;
        const screen = await renderSettingsView(view('empty'));
        const clear = () => screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear');
        expect(clear() !== null).toBe(true);
        expect(clear()!.props.disabled).toBe(true);
        await act(async () => { empty.resolve({ ...listed, results: [], count: 0, bytes: 0 }); });
        // Establish that the real binding and strict inventory parser settled before the visibility RED.
        await vi.waitFor(() => expect(screen.getTextContent())
            .toContain(t('walkthroughSettings.savedCount', { count: 0, bytes: formatByteSize(0) })));
        await vi.waitFor(() => expect(clear() === null).toBe(true));
        await screen.update(view('populated'));
        await vi.waitFor(() => expect(clear()?.props.disabled).toBe(false));
        await screen.update(view('offline'));
        await vi.waitFor(() => expect(clear() !== null).toBe(true));
        expect(clear()!.props.disabled).toBe(true);
        await screen.unmount();
    });

    it('allows opting out with an unavailable model but refuses opting in', async () => {
        function Controlled() {
            const [enabled, setEnabled] = React.useState(true);
            return <WalkthroughSavedSettings machineId={null} serverId={null} machineName=""
                prepareAfterTurn={enabled} onPrepareAfterTurn={setEnabled} modelAvailable={false} />;
        }
        const screen = await renderSettingsView(<Controlled />);
        const toggle = () => screen.findAll(node => node.type === Switch)[0];
        expect(toggle().props.value).toBe(true);
        expect(toggle().props.disabled).toBe(false);
        await act(async () => { toggle().props.onValueChange(false); });
        expect(toggle().props.value).toBe(false);
        expect(toggle().props.disabled).toBe(true);
        await act(async () => { toggle().props.onValueChange(true); });
        expect(toggle().props.value).toBe(false);
        await screen.unmount();
    });
});
