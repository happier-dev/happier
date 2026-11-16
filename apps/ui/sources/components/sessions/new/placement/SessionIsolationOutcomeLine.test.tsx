import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { proposeMachineIsolationOutcome } from '@/sync/domains/machines/machineIsolationPolicy';

installMachinesSettingsCommonModuleMocks();
// Collect the real component graph before the per-test deadline starts.
await import('./SessionIsolationOutcomeLine');

const docker = { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' };
const policy: MachineIsolationPolicyV1 = {
    configuredSandboxes: { node: { provisioner: docker, presetId: 'node-22' } },
    workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'fresh' },
        botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'shared-kept' } },
};
const stored = { status: 'ready', source: 'stored', policy, metadataVersion: 3 } as const;
const unset = { status: 'ready', source: 'default', policy: { configuredSandboxes: {}, workKinds: {
    sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } }, metadataVersion: 1 } as const;

async function render(props: Partial<React.ComponentProps<typeof import('./SessionIsolationOutcomeLine').SessionIsolationOutcomeLine>>) {
    const { SessionIsolationOutcomeLine } = await import('./SessionIsolationOutcomeLine');
    const screen = await renderScreen(React.createElement(SessionIsolationOutcomeLine, {
        serverId: null, machineName: 'devbox', snapshot: unset, outcome: undefined, ...props,
    } as never));
    const text = screen.findAllByType(Text as never).map(node => String(node.props.children)).join(' ');
    const link = findTestInstanceByTypeWithProps(screen, TextLinkButton, { testID: 'session-isolation-outcome.link' })?.props;
    return { text, link };
}

describe('session isolation outcome line', () => {
    it('says the work runs directly when the Machine has no policy, with nothing to override', async () => {
        const { text, link } = await render({ outcome: proposeMachineIsolationOutcome(unset, 'sessions') ?? undefined });
        expect(text).toContain('machineDetailPage.isolation.outcome.directly');
        expect(link).toBeUndefined();
    });

    it('offers "Run directly this time" only to a host that passes the one-Session override', async () => {
        const outcome = proposeMachineIsolationOutcome(stored, 'sessions') ?? undefined;
        const onOverrideChange = vi.fn();
        const manage = await render({ snapshot: stored, outcome, onOverrideChange });
        expect(manage.text).toContain('machineDetailPage.isolation.outcome.fresh');
        expect(manage.link?.label).toBe('machineDetailPage.isolation.outcome.runDirectlyOnce');
        manage.link?.onPress();
        expect(onOverrideChange).toHaveBeenCalledWith('directly');
        const workflow = await render({ snapshot: stored, outcome: proposeMachineIsolationOutcome(stored, 'automationsWorkflows') ?? undefined });
        expect(workflow.text).toContain('machineDetailPage.isolation.outcome.kept');
        expect(workflow.link).toBeUndefined();
    });

    it('says an offline Machine keeps the draft, with no override to offer until it is back', async () => {
        const { text, link } = await render({ snapshot: stored, outcome: proposeMachineIsolationOutcome(stored, 'sessions') ?? undefined,
            offline: true, onOverrideChange: vi.fn() });
        expect(text).toContain('machineDetailPage.isolation.outcome.offline');
        expect(text).not.toContain('machineDetailPage.isolation.outcome.fresh');
        expect(link).toBeUndefined();
    });

    it('says the one-time override and puts the sandbox back', async () => {
        const onOverrideChange = vi.fn();
        const { text, link } = await render({ snapshot: stored, outcome: proposeMachineIsolationOutcome(stored, 'sessions', 'directly') ?? undefined,
            override: 'directly', onOverrideChange });
        expect(text).toContain('machineDetailPage.isolation.outcome.directlyOnce');
        link?.onPress();
        expect(onOverrideChange).toHaveBeenCalledWith(undefined);
    });
});
