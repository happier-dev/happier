import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { proposeMachineIsolationOutcome } from '@/sync/domains/machines/machineIsolationPolicy';
import { projectMachineManagedPresence, describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';

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

    it.each([stored, { status: 'unavailable' } as const])('uses the picker’s absent fact instead of promising a deleted Machine will return (snapshot=$status)', async snapshot => {
        const machine = { id: 'guest', active: false, activeAt: 0 };
        const managed = ManagedMachineV1Schema.parse({ id: 'native', homeId: 'home', custodianAccountId: 'owner',
            enrolledMachineId: machine.id, launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1,
                name: 'devbox', choices: {} }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: {} },
            desired: 'delete', desiredWhen: 'now', intentRevision: 2, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 2, availability: 'absent' } });
        const managedPresence = projectMachineManagedPresence(machine, managed);
        const picker = describeMachinePresenceLine(machine, undefined, managedPresence, { serverId: 'home', accountId: 'member' });
        const { text, link } = await render({ snapshot, offline: true, managedPresence, onOverrideChange: vi.fn() });
        expect(text).toContain(picker.label);
        expect(text).toContain('managedPower.resourceAbsent');
        expect(text).not.toContain('machineDetailPage.isolation.outcome.offline');
        expect(link).toBeUndefined();
    });

    it('leads a fresh sandbox with what happens to the folder; its verb phrase is the one per-Session choice', async () => {
        const { SessionIsolationOutcomeLine } = await import('./SessionIsolationOutcomeLine');
        const outcome = proposeMachineIsolationOutcome(stored, 'sessions') ?? undefined;
        const onChange = vi.fn();
        const source = { target: { serverId: 'home', machineId: 'devbox' }, directory: '/home/leeroy/code/happier' };
        const renderLine = (override?: import('@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1').SessionProjectFilesV1) =>
            renderScreen(React.createElement(SessionIsolationOutcomeLine, { serverId: null, machineName: 'devbox', snapshot: stored,
                outcome, onOverrideChange: vi.fn(), projectFiles: { source, override, onChange } }));
        const textOf = (screen: Awaited<ReturnType<typeof renderLine>>) =>
            screen.findAllByType(Text as never).map(node => String(node.props.children)).join(' ');
        const menuOf = (screen: Awaited<ReturnType<typeof renderLine>>) => screen.findAllByType(DropdownMenu)
            .find(menu => menu.props.testID === 'session-isolation-outcome.project-files')!;
        const copy = await renderLine();
        expect(textOf(copy)).toContain('machineDetailPage.projectFiles.intoFresh');
        expect(textOf(copy)).not.toContain('machineDetailPage.isolation.outcome.fresh');
        // An unset preset copies once; Run directly stays beside it.
        expect(menuOf(copy).props.selectedId).toBe('copy_once');
        expect(findTestInstanceByTypeWithProps(copy, TextLinkButton, { testID: 'session-isolation-outcome.link' })?.props.label)
            .toBe('machineDetailPage.isolation.outcome.runDirectlyOnce');
        menuOf(copy).props.onSelect('keep_both_in_sync');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'sync', mode: 'keep_both_in_sync' });
        const twoWay = await renderLine({ kind: 'sync', mode: 'keep_both_in_sync' });
        expect(textOf(twoWay)).toContain('machineDetailPage.projectFiles.withFresh');
        expect(menuOf(twoWay).props.selectedId).toBe('keep_both_in_sync');
        // Choosing the preset's own option goes back to the default rather than pinning a copy of it.
        menuOf(twoWay).props.onSelect('copy_once');
        expect(onChange).toHaveBeenLastCalledWith(undefined);
        // Git clone takes the folder's repository and current branch for this session.
        expect(menuOf(twoWay).props.items.find((item: { id: string }) => item.id === 'git_clone')?.disabled).toBeUndefined();
        menuOf(twoWay).props.onSelect('git_clone');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'git_clone' });
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
