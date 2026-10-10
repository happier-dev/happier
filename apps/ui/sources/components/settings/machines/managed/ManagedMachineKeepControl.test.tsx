import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { buildRetentionChoices } from './managedRetentionPresentation';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
afterEach(() => standardCleanup());

describe('retained wake choices', () => {
    it('offers Until-delete wake on the compact detail and excludes a destruction rule', async () => {
        const { ManagedMachinePolicySection } = await import('./ManagedMachineDetailSections');
        const onChange = vi.fn();
        const keep = { policy: { retention: { kind: 'until-delete' } as const, wakeOnAcceptedMessage: false },
            inherited: false, canWake: true, consequence: () => 'Kept', onChange, onReset: vi.fn() };
        const screen = await renderScreen(<ManagedMachinePolicySection description="Keep"
            keep={keep} compactSummary={{ summary: 'Until deleted', onPress: vi.fn() }} testID="policy" />);
        const wake = screen.tree.findAll(node => typeof node.props.onValueChange === 'function')[0];
        expect(wake?.props.value).toBe(false);
        await act(async () => wake?.props.onValueChange(true));
        expect(onChange).toHaveBeenCalledWith({ ...keep.policy, wakeOnAcceptedMessage: true });
        await screen.update(<ManagedMachinePolicySection description="Keep"
            keep={{ ...keep, policy: { retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' }, wakeOnAcceptedMessage: false } }}
            compactSummary={{ summary: 'Delete after unused', onPress: vi.fn() }} testID="policy" />);
        expect(screen.tree.findAll(node => typeof node.props.onValueChange === 'function')).toHaveLength(0);
        await screen.unmount();
    });
});

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

    it('retains the authored date and effect after a conflict for re-review, then clears them after saving', async () => {
        const onChange = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const screen = await render(onChange, true);
        await screen.pressByTestIdAsync('keep:choice:deadline');
        await type(screen, 'keep:deadline-date-input', '2099-01-02');
        await type(screen, 'keep:deadline-time-input', '18:30');
        await screen.pressByTestIdAsync('keep:deadline:effect:delete');
        await screen.pressByTestIdAsync('keep:deadline:confirm');
        const date = screen.tree.findAll(node => node.props.testID === 'keep:deadline-date-input'
            && typeof node.props.onChangeText === 'function')[0];
        const time = screen.tree.findAll(node => node.props.testID === 'keep:deadline-time-input'
            && typeof node.props.onChangeText === 'function')[0];
        expect(date?.props.value).toBe('2099-01-02');
        expect(time?.props.value).toBe('18:30');
        expect(screen.findByTestId('keep:deadline:interrupts')).not.toBeNull();
        await screen.pressByTestIdAsync('keep:deadline:confirm');
        const expected = { retention: { kind: 'deadline', at, effect: 'delete', interrupts: true }, wakeOnAcceptedMessage: false };
        expect(onChange.mock.calls.map(([policy]) => policy)).toEqual([expected, expected]);
        expect(screen.findByTestId('keep:deadline:confirm')).toBeNull();
        await screen.unmount();
    });

    it('retains the deadline review when Reset is pending, then clears it only after a successful Reset', async () => {
        const { ManagedMachineKeepControl } = await import('./ManagedMachineKeepControl');
        const onReset = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const onChange = vi.fn().mockResolvedValue(false);
        const screen = await renderScreen(<ManagedMachineKeepControl
            policy={{ retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }}
            defaultPolicy={{ retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true }}
            inherited={false} presentation="choices" effects={['stop', 'delete']} canWake deadline
            consequence={() => 'Kept'} onChange={onChange} onReset={onReset} testID="keep" />);
        await screen.pressByTestIdAsync('keep:choice:deadline');
        await type(screen, 'keep:deadline-date-input', '2099-01-02');
        await type(screen, 'keep:deadline-time-input', '18:30');
        await screen.pressByTestIdAsync('keep:deadline:effect:delete');
        await screen.pressByTestIdAsync('keep:reset');
        expect(screen.tree.findAll(node => node.props.testID === 'keep:deadline-date-input'
            && typeof node.props.onChangeText === 'function')[0]?.props.value).toBe('2099-01-02');
        await screen.pressByTestIdAsync('keep:deadline:confirm');
        // A failed Reset does not turn the authored Delete into a Stop or discard its time.
        expect(onChange).toHaveBeenCalledWith({ retention: { kind: 'deadline', at, effect: 'delete', interrupts: true },
            wakeOnAcceptedMessage: false });
        expect(screen.findByTestId('keep:deadline:confirm')).not.toBeNull();
        await screen.pressByTestIdAsync('keep:reset');
        expect(onReset).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('keep:deadline-date-input') === null).toBe(true);
        expect(screen.findByTestId('keep:deadline:confirm') === null).toBe(true);
        await screen.unmount();
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
            inherited presentation="choices" finiteOnly effects={['delete']} canWake deadline
            nativeDuration={{ value: 'short', choices: [{ id: 'short', title: '1 hour' }, { id: 'long', title: '2 hours' }], onChange: onDuration }}
            consequence={() => 'Ends'} onChange={onPolicy} onReset={vi.fn()} testID="finite" />);
        expect(screen.findByTestId('finite:retention')).not.toBeNull();
        expect(screen.findByTestId('finite:choice:until-delete')).toBeNull();
        expect(screen.findByTestId('finite:wake:switch')).toBeNull();
        expect(screen.findByTestId('finite:choice:deadline')).toBeNull();
        expect(screen.findByTestId('finite:deadline-date-input')).toBeNull();
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
