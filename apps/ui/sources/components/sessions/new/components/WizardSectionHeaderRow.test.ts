import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WizardSectionHeaderRow } from './WizardSectionHeaderRow';
import { pressTestInstance, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('WizardSectionHeaderRow', () => {
    it('renders the optional action and invokes its handler', async () => {
        const onPress = vi.fn();

        const screen = await renderScreen(React.createElement(WizardSectionHeaderRow, {
                    iconName: 'desktop-outline',
                    title: 'Select Machine',
                    action: {
                        accessibilityLabel: 'Refresh machines',
                        iconName: 'refresh-outline',
                        onPress,
                    },
                }));

        expect(screen.getTextContent()).toContain('Select Machine');

        const action = screen.findByProps({ accessibilityLabel: 'Refresh machines' });
        expect(action).toBeTruthy();

        pressTestInstance(action, 'Refresh machines');

        expect(onPress).toHaveBeenCalledTimes(1);
    });
});
