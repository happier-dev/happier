import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { buildRetentionChoices } from './managedRetentionPresentation';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
afterEach(() => standardCleanup());

describe('finite resource lifetime control', () => {
    it('names the retention choice group for native and web accessibility', async () => {
        const { ManagedMachineKeepControl } = await import('./ManagedMachineKeepControl');
        const screen = await renderScreen(<ManagedMachineKeepControl
            policy={{ retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }}
            inherited presentation="choices" consequence={() => 'Kept'}
            onChange={() => {}} onReset={() => {}} testID="retention" />);
        const group = screen.findAllByType('View' as never).find(node => node.props.accessibilityRole === 'radiogroup');
        expect(group).toBeDefined();
        expect(group?.props.accessibilityLabel).toBeTruthy();
        expect(group?.props.accessibilityLabel).toBe(group?.props['aria-label']);
    });

    it('discloses a known live native expiry as information without offering a creation duration mutation', async () => {
        const { ManagedMachineKeepControl } = await import('./ManagedMachineKeepControl');
        const onChange = vi.fn();
        const screen = await renderScreen(<ManagedMachineKeepControl policy={{ retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' }, wakeOnAcceptedMessage: false }}
            inherited presentation="field" finiteOnly effects={['delete']} canWake nativeExpiry="Native lease ends in two hours"
            consequence={() => 'Ends'} onChange={onChange} onReset={vi.fn()} testID="live-finite" />);
        const field = screen.tree.findAll(node => node.props.testID === 'live-finite:retention' && node.props.mode === 'info')[0];
        expect(field?.props.subtitle).toBe('Native lease ends in two hours');
        expect(field?.props.onPress).toBeUndefined();
        expect(screen.findByTestId('live-finite:wake:switch')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('offers one finite lifetime field with no retained-forever or wake option', async () => {
        const { ManagedMachineKeepControl } = await import('./ManagedMachineKeepControl');
        const retention = { kind: 'unused', afterMs: 3_600_000, effect: 'delete' } as const;
        const onDuration = vi.fn(); const onPolicy = vi.fn();
        const screen = await renderScreen(<ManagedMachineKeepControl policy={{ retention, wakeOnAcceptedMessage: false }}
            inherited presentation="choices" finiteOnly effects={['delete']} canWake
            nativeDuration={{ value: 'short', choices: [{ id: 'short', title: '1 hour' }, { id: 'long', title: '2 hours' }], onChange: onDuration }}
            consequence={() => 'Ends'} onChange={onPolicy} onReset={vi.fn()} testID="finite" />);
        expect(screen.findByTestId('finite:retention')).not.toBeNull();
        expect(screen.findByTestId('finite:choice:until-delete')).toBeNull();
        expect(screen.findByTestId('finite:wake:switch')).toBeNull();
        const choices = buildRetentionChoices({ current: retention, effects: ['delete'], finiteOnly: true });
        expect(choices.length).toBeGreaterThan(1);
        expect(choices.every(choice => choice.retention.kind !== 'until-delete' && choice.retention.effect === 'delete')).toBe(true);
        const durationField = screen.tree.findAll(node => node.props.selectedId === 'short' && typeof node.props.onSelect === 'function')[0];
        await act(async () => durationField?.props.onSelect('long'));
        expect(onDuration).toHaveBeenCalledWith('long');
        expect(onPolicy).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
