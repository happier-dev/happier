import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
afterEach(() => standardCleanup());

type Provisioner = MachineProvisionersListResultV1['provisioners'][number];
function provisioner(icon: string): Provisioner {
    return { contribution: { pluginId: 'custom.compute', localId: 'native' }, occurrenceId: 'native-occurrence', descriptor: {
        id: 'native', title: 'Native compute', icon, resourceKind: 'VM', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    } };
}
function Presentation(props: Readonly<{ icon: string }>) {
    const presentation = useManagedProvisionerPresentation({ serverId: '', provisioner: provisioner(props.icon) });
    return <>{presentation.mark}</>;
}

describe('managed provisioner presentation', () => {
    it('renders the declared Action icon through the canonical renderer compatibility owner', async () => {
        const screen = await renderScreen(<Presentation icon="magic-wand" />);
        expect(screen.tree.findAll(node => node.props.name === 'magic-wand').length).toBeGreaterThan(0);
        await screen.unmount();
        const unknown = await renderScreen(<Presentation icon="unknown-plugin-action-icon" />);
        expect(unknown.tree.findAll(node => node.props.name === 'puzzle-piece').length).toBeGreaterThan(0);
        await unknown.unmount();
    });
});
