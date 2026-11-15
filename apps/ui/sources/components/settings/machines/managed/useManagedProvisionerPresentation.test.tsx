import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createMachineFixture, createValidPluginBrandPngFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginPortableReleaseManifestV1Schema,
    readDeclaredPackageAssetsV1 } from '@happier-dev/protocol/plugins/availability';
import { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/machine-vercel/src/manifest';

const bundledMarks = vi.hoisted(() => [] as { pluginId: string; resourceId: string; releaseVersion: string; displayName: string; digest: string; bytes: Uint8Array }[]);
// App-published artwork is an asset boundary; keep the brand admission and rendering real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [], BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [], BUNDLED_PLUGIN_BRAND_MARKS: bundledMarks,
}));

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
afterEach(() => standardCleanup());

type Provisioner = MachineProvisionersListResultV1['provisioners'][number];
function provisioner(icon: string, pluginId = 'custom.compute'): Provisioner {
    return { contribution: { pluginId, localId: 'native' }, occurrenceId: 'native-occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
        id: 'native', title: 'Native compute', icon, resourceKind: 'VM', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    } };
}
function Presentation(props: Readonly<{ icon: string; pluginId?: string }>) {
    const presentation = useManagedProvisionerPresentation({ serverId: '', provisioner: provisioner(props.icon, props.pluginId) });
    return <>{presentation.mark}</>;
}

describe('managed provisioner presentation', () => {
    it.each(['presentation', 'offer'] as const)('presents declaration facts from the already-selected custom Account provisioner (%s)', async purpose => {
        const original = PLUGIN_MANIFEST.contributes.machineProvisioners![0]!;
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ ...PLUGIN_MANIFEST, id: 'custom.compute.resize',
            contributes: { ...PLUGIN_MANIFEST.contributes, machineProvisioners: [{ ...original, resize: {
                cpuCores: { kind: 'unsupported', code: 'account_cpu_unsupported' },
                memoryBytes: { kind: 'unsupported', code: 'account_memory_unsupported' },
                diskBytes: { kind: 'unsupported', code: 'account_disk_unsupported' },
            } }] } });
        const scope = { serverId: 'account-resize-presentation', accountId: 'owner' };
        // Account Availability HTTP is the declaration boundary. Its real scoped
        // projection and selected-manifest resolver remain beneath the hook.
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
            intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId: manifest.id, version: manifest.version },
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                collectionContracts: [], uiSlots: [], packageAssetArchive: {
                    archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
                    resources: readDeclaredPackageAssetsV1(manifest)!.map(resource => ({ ...resource,
                        byteSize: 1, digestSha256: `sha256:${'c'.repeat(64)}` })),
                } }, packageAssets: [], uiArtifacts: [],
        });
        onTestFinished(clearPluginAccountAvailabilityProjection);
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
            intentReads: [{ pluginId: manifest.id, response }], materializations: [], snapshots: [] } });
        expect(readPluginAccountAvailability(scope).readCurrentAccountExecution(manifest.id).kind).toBe('available');
        const hook = await renderHook(() => useManagedProvisionerPresentation({ serverId: scope.serverId, accountScope: scope,
            provider: { pluginId: manifest.id, localId: original.id }, schemaVersion: original.schemaVersion, purpose }));
        expect(hook.getCurrent().descriptor?.resize?.diskBytes).toEqual({ kind: 'unsupported', code: 'account_disk_unsupported' });
        expect(hook.getCurrent().savedLaunchPresentation?.schema).toEqual(original.launchSchema);
        await hook.unmount();
    });
    it('does not render Preset presenters for resource-only publications, but observes installation replacement', async () => {
        await selectActiveTestHomeForTests();
        const serverId = getActiveServerSnapshot().serverId;
        const previous = storage.getState();
        let machine = createMachineFixture({ id: 'controller', installationId: 'previous-installation',
            daemonStateVersion: 1, daemonState: { status: 'running', resources: { activeSessions: 0 } } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const input = { serverId, controller: { machineId: machine.id, installationId: 'expected-installation' },
            provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, purpose: 'mark' as const };
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useManagedProvisionerPresentation(input); });
        try {
            await flushHookEffects({ cycles: 30 });
            renders = 0;
            for (let arrival = 1; arrival <= 12; arrival += 1) {
                machine = { ...machine, daemonStateVersion: arrival + 1,
                    daemonState: { ...machine.daemonState, resources: { activeSessions: arrival } } };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            }
            expect(storage.getState().machineListByServerId[serverId]?.[0]?.daemonState?.resources).toEqual({ activeSessions: 12 });
            expect(renders).toBe(0);
            machine = { ...machine, installationId: input.controller.installationId };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            await flushHookEffects();
            expect(renders).toBeGreaterThan(0);
            renders = 0;
            await act(async () => storage.getState().applyMachines([], true, { sourceServerId: serverId }));
            expect(renders).toBeGreaterThan(0);
        } finally {
            await hook.unmount();
            storage.setState(previous);
        }
    });
    it('renders the app-published package mark on an Add card without a controller projection', async () => {
        const bytes = createValidPluginBrandPngFixture();
        bundledMarks.push({ pluginId: 'custom.compute.branded', resourceId: 'brand-icon', releaseVersion: '0.0.0',
            displayName: 'Native compute', digest: `sha256:${'b'.repeat(64)}`, bytes });
        try {
            const screen = await renderScreen(<Presentation icon="cube" pluginId="custom.compute.branded" />);
            expect(screen.tree.findAll(node => node.props.brand?.bytes === bytes).length).toBeGreaterThan(0);
            expect(screen.tree.findAll(node => node.props.name === 'cube')).toHaveLength(0);
            await screen.unmount();
        } finally { bundledMarks.length = 0; }
    });
    it('renders the declared Action icon through the canonical renderer compatibility owner', async () => {
        const screen = await renderScreen(<Presentation icon="magic-wand" />);
        expect(screen.tree.findAll(node => node.props.name === 'magic-wand').length).toBeGreaterThan(0);
        await screen.unmount();
        const unknown = await renderScreen(<Presentation icon="unknown-plugin-action-icon" />);
        expect(unknown.tree.findAll(node => node.props.name === 'puzzle-piece').length).toBeGreaterThan(0);
        await unknown.unmount();
    });
    it('holds a blank mark of the same size while the controller projection resolves, never the generic glyph first (UIR5c)', async () => {
        function PresetMark() {
            const presentation = useManagedProvisionerPresentation({ serverId: 'srv_resolving', schemaVersion: 1,
                controller: { machineId: 'controller', installationId: 'installation' }, provider: { pluginId: 'custom.compute', localId: 'native' } });
            return <>{presentation.markAt(17)}</>;
        }
        const screen = await renderScreen(<PresetMark />);
        expect(screen.tree.findAll(node => node.props.name === 'puzzle-piece')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props.style?.width === 17 && node.props.style?.height === 17).length).toBeGreaterThan(0);
        await screen.unmount();
    });
    it('uses the bundled provisioner declaration immediately while the controller projection resolves', async () => {
        function CuaPresentation() {
            const presentation = useManagedProvisionerPresentation({ serverId: 'srv_resolving', schemaVersion: 1,
                controller: { machineId: 'controller', installationId: 'installation' },
                provider: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' } });
            return <>{presentation.mark}<Text>{presentation.title}</Text><Text>{presentation.kindTitle}</Text></>;
        }
        const screen = await renderScreen(<CuaPresentation />);
        expect(screen.getTextContent()).toContain('Cua');
        expect(screen.getTextContent()).toContain('sandbox');
        expect(screen.tree.findAll(node => node.props.name === 'desktop').length).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props.name === 'puzzle-piece')).toHaveLength(0);
        await screen.unmount();
    });
});
