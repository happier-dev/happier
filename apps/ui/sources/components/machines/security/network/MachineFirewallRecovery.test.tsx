import * as React from 'react';
import { expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { MachineFirewallRecovery } from './MachineFirewallRecovery';

installMachinesSettingsCommonModuleMocks();

it('shows copyable owner-derived restore commands instead of the captured JSON', async () => {
    const restore = { capturedAt: '2026-11-15T12:00:00.000Z', commands: ['/usr/sbin/nft delete table inet happier'] };
    const recovery = { rules: { kind: 'absent' as const }, unit: { kind: 'absent' as const }, table: null,
        boot: { present: false, enabled: false, running: false }, restore };
    const screen = await renderScreen(<MachineFirewallRecovery recovery={recovery} />);
    const block = screen.findByType(CodeBlockView);
    expect(block.props.code).toBe(restore.commands.join('\n'));
    expect(block.props.language).toBe('shell');
    expect(block.props.showCopyButton).toBe(true);
});
