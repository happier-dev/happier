import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    reactNative: async () => {
        const [{ createCapturingFlatListMock }, { createReactNativeWebMock }] = await Promise.all([
            import('@/dev/testkit/mocks/virtualizedList'),
            import('@/dev/testkit/mocks/reactNative'),
        ]);
        // The native list boundary must mount its cells; the default host stub does not call renderItem.
        return createReactNativeWebMock(createCapturingFlatListMock({ renderItems: true }).module);
    },
});
afterEach(() => standardCleanup());

const sizes = [
    { id: 'small', name: 'Small', cpu: '4', memory: '8 GB', disk: '64 GB', spec: 'Small', headroom: '10 cores · 40 GB' },
    { id: 'medium', name: 'Medium', cpu: '6', memory: '16 GB', disk: '128 GB', spec: 'Medium', headroom: '8 cores · 32 GB' },
];

describe('managed size comparison', () => {
    it('discloses an unknown rate beside a known native rate in the comparison table', async () => {
        const { ManagedSizeTable } = await import('./ManagedChoiceSections');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ManagedSizeTable sizes={[{ ...sizes[0]!, hourly: '€0.01' }, sizes[1]!]} value="medium"
            onChange={vi.fn()} testID="sizes" />);
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('sizes:stage'), 'onLayout', {
                // At phone width Collection intentionally drops columns that cannot fit beside its title.
                nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 600 } },
            });
        });
        expect(screen.getTextContent()).toContain('€0.01');
        expect(screen.getTextContent()).toContain(t('common.unknown'));
        await screen.unmount();
    });
    it('keeps what the chosen local size leaves this computer beneath the table instead of dropping it', async () => {
        const { ManagedSizeTable } = await import('./ManagedChoiceSections');
        const phone = await renderScreen(<ManagedSizeTable sizes={sizes} value="medium" onChange={vi.fn()}
            headroomTitle="Left for MacBook Pro" compact testID="sizes" />);
        const row = phone.tree.findAll(node => node.props.testID === 'sizes:headroom' && node.props.title !== undefined)[0];
        expect(row?.props.title).toBe('Left for MacBook Pro');
        expect((row?.props.rightElement as React.ReactElement<{ text: string }> | undefined)?.props.text).toBe('8 cores · 32 GB');
        await phone.unmount();
        const cloudPhone = await renderScreen(<ManagedSizeTable sizes={sizes} value="medium" onChange={vi.fn()} compact testID="sizes" />);
        expect(cloudPhone.findByTestId('sizes:headroom')).toBeNull();
        await cloudPhone.unmount();
    });
});

describe('managed location choice', () => {
    it('names a country only from its ISO code', async () => {
        const { countryName } = await import('./managedMachineDisplay');
        expect(countryName('DE', 'en')).toBe('Germany');
        expect(countryName(undefined, 'en')).toBe('');
        expect(countryName('Falkenstein', 'en')).toBe('');
    });

    it('offers each region as one radio with its country and never selects an unavailable one', async () => {
        const { ManagedLocationGroup } = await import('./ManagedChoiceSections');
        const onChange = vi.fn();
        const screen = await renderScreen(<ManagedLocationGroup title="Location" value="fsn1" onChange={onChange} testID="locations"
            locations={[
                { id: 'fsn1', city: 'Falkenstein', country: 'Germany', countryCode: 'DE' },
                { id: 'hel1', city: 'Helsinki', country: 'Finland', countryCode: 'FI' },
                { id: 'ash', city: 'Ashburn', country: 'United States', unavailableReason: 'Unavailable' },
            ]} />);
        const radios = screen.tree.findAll(node => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function'
            && String(node.props.testID).startsWith('locations:'));
        expect(radios.map(node => node.props.accessibilityLabel)).toEqual(expect.arrayContaining([
            'Falkenstein, Germany', 'Helsinki, Finland', 'Ashburn, Unavailable',
        ]));
        await screen.pressByTestIdAsync('locations:hel1');
        expect(onChange).toHaveBeenCalledWith('hel1');
        const unavailable = radios.find(node => node.props.testID === 'locations:ash');
        expect(unavailable?.props.disabled).toBe(true);
        await screen.unmount();
    });
});
