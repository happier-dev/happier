import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { useWizardChromeOverrides } from './useWizardChromeOverrides';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useWizardChromeOverrides', () => {
    it('does not churn equivalent primary overrides across parent rerenders and still uses the latest handler', async () => {
        const renderCountRef = { current: 0 };
        const pressedTicks: number[] = [];
        let bumpTick: (() => void) | null = null;
        let latestPrimaryOverride: ReturnType<typeof useWizardChromeOverrides>['activePrimaryOverride'] = null;

        function Harness() {
            const [tick, setTick] = React.useState(0);
            const overrides = useWizardChromeOverrides('setup_chooser');

            renderCountRef.current += 1;
            latestPrimaryOverride = overrides.activePrimaryOverride;
            bumpTick = () => setTick((current) => current + 1);

            React.useEffect(() => {
                overrides.setWizardPrimaryOverride({
                    label: React.createElement('Label', null, 'Continue'),
                    disabled: false,
                    onPress: () => {
                        pressedTicks.push(tick);
                    },
                });
            }, [overrides.setWizardPrimaryOverride, tick]);

            return React.createElement('State', { renderCount: renderCountRef.current, tick });
        }

        const screen = await renderScreen(React.createElement(Harness));

        expect(screen.findByType('State' as never).props.renderCount).toBe(2);

        await act(async () => {
            bumpTick?.();
        });

        expect(screen.findByType('State' as never).props.renderCount).toBe(3);

        await act(async () => {
            await latestPrimaryOverride?.onPress?.();
        });

        expect(pressedTicks).toEqual([1]);
    });
});
