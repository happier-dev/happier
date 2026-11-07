import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invokeTestInstanceHandler,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  reactNative: async () => {
    const [{ createCapturingFlatListMock }, { createReactNativeWebMock }] =
      await Promise.all([
        import('@/dev/testkit/mocks/virtualizedList'),
        import('@/dev/testkit/mocks/reactNative'),
      ]);
    // The native list boundary must mount its cells; the default host stub does not call renderItem.
    return createReactNativeWebMock(
      createCapturingFlatListMock({ renderItems: true }).module,
    );
  },
});
const { ManagedSizeTable } = await import('./ManagedChoiceSections');
afterEach(() => standardCleanup());

const sizes = [
  {
    id: 'small',
    name: 'Small',
    cpu: '4',
    memory: '8 GB',
    disk: '64 GB',
    spec: 'Small',
    headroom: '10 cores · 40 GB',
  },
  {
    id: 'medium',
    name: 'Medium',
    cpu: '6',
    memory: '16 GB',
    disk: '128 GB',
    spec: 'Medium',
    headroom: '8 cores · 32 GB',
  },
];

describe('managed size comparison', () => {
  it.each([390, 960])('shows a memory warning while keeping the size selectable at %ipx', async width => {
    const warning = 'Low memory for Happier and an agent';
    const onChange = vi.fn();
    const screen = await renderScreen(<ManagedSizeTable sizes={[{ ...sizes[0]!, warning }]}
      value={null} onChange={onChange} testID="sizes" />);
    await act(async () => {
      invokeTestInstanceHandler(screen.findByTestId('sizes:stage'), 'onLayout', {
        nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } },
      });
    });
    expect(screen.getTextContent()).toContain(warning);
    const radio = screen.tree.findAll(node => node.props.accessibilityRole === 'radio'
      && typeof node.props.onPress === 'function' && node.props.testID === 'sizes:small')[0];
    expect(radio?.props.accessibilityLabel).toContain(warning);
    expect(radio?.props.disabled).not.toBe(true);
    await screen.pressByTestIdAsync('sizes:small');
    expect(onChange).toHaveBeenCalledWith('small');
    await screen.unmount();
  });
  it.each([390, 590, 960])('keeps CPU and RAM facts readable in a %ipx configurator', async width => {
    const { t } = await import('@/text');
    const screen = await renderScreen(<ManagedSizeTable sizes={sizes.map(size => ({ ...size, hourly: '€0.01',
      unavailableReason: 'Not available with your other choices', selectable: true }))}
      value="small" onChange={vi.fn()} testID="sizes" />);
    await act(async () => {
      invokeTestInstanceHandler(screen.findByTestId('sizes:stage'), 'onLayout', {
        nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } },
      });
    });
    const text = screen.getTextContent();
    expect(text).toContain('8 GB');
    expect(text).toContain('16 GB');
    expect(text).toContain(t('managedMachines.receipt.cores', { count: 4 }));
    expect(text).toContain(t('managedMachines.receipt.cores', { count: 6 }));
    await screen.unmount();
  });
  it('discloses an unknown rate beside a known native rate in the comparison table', async () => {
    const { ManagedSizeTable } = await import('./ManagedChoiceSections');
    const { t } = await import('@/text');
    const screen = await renderScreen(
      <ManagedSizeTable
        sizes={[{ ...sizes[0]!, hourly: '€0.01' }, sizes[1]!]}
        value="medium"
        onChange={vi.fn()}
        testID="sizes"
      />,
    );
    await act(async () => {
      invokeTestInstanceHandler(
        screen.findByTestId('sizes:stage'),
        'onLayout',
        {
          // At phone width Collection intentionally drops columns that cannot fit beside its title.
          nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 600 } },
        },
      );
    });
    expect(screen.getTextContent()).toContain('€0.01');
    expect(screen.getTextContent()).toContain(t('common.unknown'));
    await screen.unmount();
  });
  it('keeps what the chosen local size leaves this computer beneath the table instead of dropping it', async () => {
    const { ManagedSizeTable } = await import('./ManagedChoiceSections');
    const phone = await renderScreen(
      <ManagedSizeTable
        sizes={sizes}
        value="medium"
        onChange={vi.fn()}
        headroomTitle="Left for MacBook Pro"
        compact
        testID="sizes"
      />,
    );
    const row = phone.tree.findAll(
      (node) =>
        node.props.testID === 'sizes:headroom' &&
        node.props.title !== undefined,
    )[0];
    expect(row?.props.title).toBe('Left for MacBook Pro');
    expect(
      (
        row?.props.rightElement as
          | React.ReactElement<{ text: string }>
          | undefined
      )?.props.text,
    ).toBe('8 cores · 32 GB');
    await phone.unmount();
    const cloudPhone = await renderScreen(
      <ManagedSizeTable
        sizes={sizes}
        value="medium"
        onChange={vi.fn()}
        compact
        testID="sizes"
      />,
    );
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
    const screen = await renderScreen(
      <ManagedLocationGroup
        title="Location"
        value="fsn1"
        onChange={onChange}
        testID="locations"
        locations={[
          {
            id: 'fsn1',
            city: 'Falkenstein',
            country: 'Germany',
            countryCode: 'DE',
          },
          {
            id: 'hel1',
            city: 'Helsinki',
            country: 'Finland',
            countryCode: 'FI',
          },
          {
            id: 'ash',
            city: 'Ashburn',
            country: 'United States',
            unavailableReason: 'Unavailable',
          },
        ]}
      />,
    );
    const radios = screen.tree.findAll(
      (node) =>
        node.props.accessibilityRole === 'radio' &&
        typeof node.props.onPress === 'function' &&
        String(node.props.testID).startsWith('locations:'),
    );
    expect(radios.map((node) => node.props.accessibilityLabel)).toEqual(
      expect.arrayContaining([
        'Falkenstein, Germany',
        'Helsinki, Finland',
        'Ashburn, Unavailable',
      ]),
    );
    await screen.pressByTestIdAsync('locations:hel1');
    expect(onChange).toHaveBeenCalledWith('hel1');
    const unavailable = radios.find(
      (node) => node.props.testID === 'locations:ash',
    );
    expect(unavailable?.props.disabled).toBe(true);
    await screen.unmount();
  });

  it('names an image by its name and tag, not its registry host, so a phone tile does not truncate to the host', async () => {
    const { ManagedImageTiles } = await import('./ManagedChoiceSections');
    const screen = await renderScreen(
      <ManagedImageTiles
        value={null}
        onChange={vi.fn()}
        testID="images"
        images={[
          { id: 'ghcr.io/trycua/linux:24.04-disk', name: 'ghcr.io/trycua/linux:24.04-disk', description: '' },
          { id: 'ubuntu', name: 'Ubuntu 24.04', description: '' },
        ]}
      />,
    );
    const radios = screen.tree.findAll(
      (node) =>
        node.props.accessibilityRole === 'radio' &&
        typeof node.props.onPress === 'function' &&
        String(node.props.testID).startsWith('images:'),
    );
    expect(radios.map((node) => node.props.accessibilityLabel)).toEqual(
      expect.arrayContaining(['linux:24.04-disk', 'Ubuntu 24.04']),
    );
    // Images with nothing to show are named in cards with room for the name, not as blank preview frames with clipped captions.
    expect(
      screen.tree.findAll((node) => node.props.variant === 'visual'),
    ).toHaveLength(0);
    await screen.unmount();
  });

  it('draws the regions as one sheet of radio cells rather than separate cards (lab m-config location grid)', async () => {
    const { ManagedLocationGroup } = await import('./ManagedChoiceSections');
    const screen = await renderScreen(
      <ManagedLocationGroup
        title="Location"
        value="fsn1"
        onChange={vi.fn()}
        testID="locations"
        locations={[
          {
            id: 'fsn1',
            city: 'Falkenstein',
            country: 'Germany',
            countryCode: 'DE',
          },
          {
            id: 'hel1',
            city: 'Helsinki',
            country: 'Finland',
            countryCode: 'FI',
          },
        ]}
      />,
    );
    const tiles = screen.tree.findAll(
      (node) =>
        node.props.testIdPrefix === 'locations' &&
        Array.isArray(node.props.options),
    );
    expect(tiles[0]?.props.surface).toBe('sheet');
    const group = screen.tree.findAll(
      (node) => node.props.title === 'Location' && 'surface' in node.props,
    );
    expect(group.every((node) => node.props.surface !== 'none')).toBe(true);
    await screen.unmount();
  });
});
