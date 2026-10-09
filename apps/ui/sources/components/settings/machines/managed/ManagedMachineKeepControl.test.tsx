import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { buildRetentionChoices } from './managedRetentionPresentation';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
afterEach(() => standardCleanup());

describe('explicit interrupting deadline', () => {
    const at = new Date(2099, 0, 2, 18, 30).getTime();
    const render = async (onChange: (policy: unknown) => void, deadline: boolean) => {
        const { ManagedMachineKeepControl } = await import('./ManagedMachineKeepControl');
        return renderScreen(<ManagedMachineKeepControl
            policy={{ retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true }}
            inherited presentation="choices" effects={['stop', 'delete']} canWake deadline={deadline}
            consequence={() => 'Kept'} onChange={onChange} onReset={vi.fn()} testID="keep" />);
    };
    const type = async (screen: Awaited<ReturnType<typeof render>>, testID: string, text: string) => {
        const input = screen.tree.findAll(node => node.props.testID === testID && typeof node.props.onChangeText === 'function')[0];
        await act(async () => input?.props.onChangeText(text));
    };

    it('authors a deadline only through its reviewed consequence, and cancel writes nothing', async () => {
        const onChange = vi.fn();
        const screen = await render(onChange, true);
        await screen.pressByTestIdAsync('keep:choice:deadline');
        await type(screen, 'keep:deadline-date-input', '2099-01-02');
        await type(screen, 'keep:deadline-time-input', '18:30');
        expect(screen.findByTestId('keep:deadline:interrupts')).not.toBeNull();
        expect(onChange).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('keep:deadline:cancel');
        expect(screen.findByTestId('keep:deadline:confirm')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('keep:choice:deadline');
        await type(screen, 'keep:deadline-date-input', '2099-01-02');
        await type(screen, 'keep:deadline-time-input', '18:30');
        await screen.pressByTestIdAsync('keep:deadline:effect:delete');
        await screen.pressByTestIdAsync('keep:deadline:confirm');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith({
            retention: { kind: 'deadline', at, effect: 'delete', interrupts: true }, wakeOnAcceptedMessage: false,
        });
        expect(screen.findByTestId('keep:deadline:confirm')).toBeNull();
        await screen.unmount();
    });

    it('names a set deadline once and keeps its interruption in view', async () => {
        const { ManagedMachineKeepControl } = await import('./ManagedMachineKeepControl');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ManagedMachineKeepControl
            policy={{ retention: { kind: 'deadline', at, effect: 'stop', interrupts: true }, wakeOnAcceptedMessage: true }}
            inherited presentation="choices" effects={['stop', 'delete']} canWake deadline
            consequence={() => 'Stop at the deadline'} onChange={vi.fn()} onReset={vi.fn()} testID="keep" />);
        const consequence = screen.tree.findAll(node => node.props.testID === 'keep:consequence' && node.props.children !== undefined)[0];
        expect(consequence?.props.children).toBe(t('managedRetention.interrupts'));
        expect(screen.findByTestId('keep:choice:deadline')).not.toBeNull();
        await screen.unmount();
    });

    it('refuses a past time and offers no deadline where the caller did not ask for one', async () => {
        const onChange = vi.fn();
        const screen = await render(onChange, true);
        await screen.pressByTestIdAsync('keep:choice:deadline');
        await type(screen, 'keep:deadline-date-input', '2001-01-02');
        await type(screen, 'keep:deadline-time-input', '18:30');
        expect(screen.findByTestId('keep:deadline-past-instant')).not.toBeNull();
        expect(screen.findByTestId('keep:deadline:interrupts')).toBeNull();
        const confirm = screen.tree.findAll(node => node.props.testID === 'keep:deadline:confirm' && node.props.title !== undefined)[0];
        expect(confirm?.props.disabled).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
        await screen.unmount();
        const plain = await render(onChange, false);
        expect(plain.findByTestId('keep:choice:deadline')).toBeNull();
        await plain.unmount();
    });
});

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
