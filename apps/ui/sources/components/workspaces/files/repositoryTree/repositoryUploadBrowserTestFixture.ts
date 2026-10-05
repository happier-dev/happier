import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { vi } from 'vitest';

const documentPickerBoundary = vi.hoisted(() => vi.fn());
export const nativeDocumentPickerBoundary = documentPickerBoundary;
vi.mock('expo-document-picker', () => ({ getDocumentAsync: documentPickerBoundary }));
vi.mock('@happier-dev/iroh-native', async importOriginal => {
    const actual = await importOriginal<typeof import('@happier-dev/iroh-native')>();
    return { ...actual, getOptionalHappierIrohNativeModule: () => ({
        // Only native SDK availability is supplied; real admission and transfer owners remain live.
        getAvailability: () => ({ available: true }),
        startMachineTunnel: async () => { throw new Error('Retired picker must not acquire a native transfer'); },
        stopMachineTunnel: async () => {},
    }) };
});

/** Current server projections enter the real admission/store owners, not an availability stub. */
export async function primeRepositoryUploadBrowserFixture() {
    const [{ getStorage }, { primeServerFeaturesSnapshot }] = await Promise.all([
        import('@/sync/domains/state/storage'), import('@/sync/api/capabilities/serverFeaturesClient'),
    ]);
    const machine = createMachineFixture({
        id: 'm1', activeAt: Date.now(), kind: 'ephemeral_session_runner',
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: {
            finiteTransferRpc: { protocolVersions: [1] },
            irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
        },
    });
    const baseSession = createSessionFixture();
    if (!baseSession.metadata) throw new Error('Expected session fixture metadata');
    const session = createSessionFixture({
        id: 's1', serverId: 'server', active: true,
        metadata: { ...baseSession.metadata, machineId: 'm1', path: '/repo' },
    });
    getStorage().setState({
        profileScope: { serverId: 'server', accountId: 'account' },
        settingsScope: { serverId: 'server', accountId: 'account' },
        machines: { m1: machine }, machineListByServerId: { server: [machine] },
        sessions: { s1: session },
    });
    primeServerFeaturesSnapshot({ serverId: 'server', snapshot: {
        status: 'ready', features: FeaturesResponseSchema.parse({ features: { machines: {
            enabled: true, transfer: { enabled: true, directPeer: { enabled: true } }, peerMediation: { enabled: true },
        } }, capabilities: {} }),
    } });
}

/** React renderer's host adapter: refs are real OS inputs and changes are real DOM events. */
export function createRepositoryPickerInputHost(
    element: Readonly<{ type: unknown; props: Record<string, unknown> }>,
    inputs: HTMLInputElement[],
    readOnChange?: () => unknown,
) {
    if (element.type !== 'input') return null;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = element.props.multiple === true;
    input.addEventListener('change', () => {
        // React DOM dispatches to the latest committed handler, not the one at ref attachment.
        const onChange = readOnChange ? readOnChange() : element.props.onChange;
        if (typeof onChange === 'function') onChange({ target: input });
    });
    inputs.push(input);
    return input;
}
