import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({
  OS: 'ios',
  select: <T,>(options: Readonly<{ ios?: T; android?: T; native?: T; default?: T }>) => (
    options.ios ?? options.android ?? options.native ?? options.default
  ),
}));

// React Native is the platform boundary. The public adapters and shared
// presentation path remain real so the assertions observe the native frames
// that receive the provider's platform fact.
vi.mock('react-native', () => ({
  Platform: nativePlatform,
  I18nManager: { isRTL: false },
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { HappierUiPlatformProvider } from '../environment/index.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import {
  Button,
  Form,
  IconButton,
  Link,
  List,
  Menu,
  Surface,
  Tabs,
  Text,
} from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function resolvePressableStyle(style: unknown): Record<string, unknown> {
  return flattenStyle(typeof style === 'function'
    ? style({
        pressed: false,
        hovered: false,
        focused: false,
        selected: false,
        busy: false,
        disabled: false,
      })
    : style);
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

async function renderInteractiveFamilies(
  platform: 'android' | 'ios' | 'desktop' | 'web',
  outerPlatform?: 'android' | 'ios' | 'desktop' | 'web',
  textScale = 1,
) {
  const context = createSurfaceContext({ platform, textScale });
  const presentationHost = {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: (input: Parameters<PluginUiPresentationHost['renderPopover']>[0]) => input.content({
      requestClose: () => input.onRequestClose(),
      maxHeight: 240,
    }),
    renderIcon: () => null,
  };

  const surface = (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost}>
          <Button testID="button" title="Run" onPress={() => undefined} />
          <IconButton testID="icon-button" accessibilityLabel="Refresh" icon={<Text value="R" />} onPress={() => undefined} />
          <Surface testID="surface" accessibilityLabel="Open details" onPress={() => undefined}>
            <Text testID="scaled-text" value="Details" variant="body" />
          </Surface>
          <List.Item testID="list-tight:first" title="First" density="tight" onPress={() => undefined} />
          <List.Item testID="list-tight:second" title="Second" density="tight" onPress={() => undefined} />
          <Form.TextField testID="text-field" label="Name" value="" onChange={() => undefined} />
          <Form.Toggle testID="toggle" label="Enabled" value={false} onChange={() => undefined} />
          <Form.Select
            testID="select"
            label="Mode"
            options={[{ value: 'safe', label: 'Safe', testID: 'select-option' }]}
            value="safe"
            onChange={() => undefined}
          />
          <Tabs testID="tabs" value="summary" onValueChange={() => undefined} ariaLabel="Sections">
            <Tabs.Item value="summary" title="Summary"><Text value="Summary" /></Tabs.Item>
          </Tabs>
          <Link testID="link" title="Documentation" url="https://docs.happier.dev" />
          <Menu
            testID="menu-trigger"
            open
            onOpenChange={() => undefined}
            trigger="More"
            triggerAccessibilityLabel="More actions"
            items={[
              { id: 'first', label: 'First action' },
              { id: 'second', label: 'Second action' },
            ]}
            onSelect={() => undefined}
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
  );

  await act(async () => {
    renderer = create(
      outerPlatform === undefined ? surface : (
        <HappierUiPlatformProvider platform={{ platform: outerPlatform, colorScheme: 'light' }}>
          {surface}
        </HappierUiPlatformProvider>
      ),
    );
  });
}

function findPressable(testID: string) {
  const target = renderer!.root.findAll((node) => (
    node.type === 'Pressable' && node.props.testID === testID
  ));
  expect(target, `missing native Pressable ${testID}`).toHaveLength(1);
  return target[0]!;
}

function expectPhysicalTarget(testID: string, minimum: number) {
  const target = findPressable(testID);
  const style = resolvePressableStyle(target.props.style);
  expect(style.minWidth, `${testID} must have a physical minimum width`).toBeGreaterThanOrEqual(minimum);
  expect(style.minHeight, `${testID} must have a physical minimum height`).toBeGreaterThanOrEqual(minimum);
  return target;
}

describe('public interactive families use the provider-owned native target policy', () => {
  for (const [platform, minimum] of [
    ['android', 48],
    ['ios', 44],
  ] as const) {
    it(`gives ${platform} the physical target across shared public families`, async () => {
      await renderInteractiveFamilies(platform);

      for (const testID of [
        'button',
        'icon-button',
        'surface',
        'list-tight:first',
        'list-tight:second',
        'toggle',
        'select-option',
        'tabs:summary',
        'link',
        'menu-trigger',
      ]) {
        const target = expectPhysicalTarget(testID, minimum);
        // Physical frames are required for adjacent controls; hit-slop-only
        // growth can overlap the next row or action.
        expect(target.props.hitSlop).toBeUndefined();
        // DOM-only semantics must not leak into the native view config. Native
        // assistive technology consumes the canonical accessibilityRole arm.
        expect(target.props.role).toBeUndefined();
        expect(target.props.onKeyDown).toBeUndefined();
        expect(target.props.accessibilityRole).toBeTypeOf('string');
      }

      const textField = renderer!.root.findAll((node) => (
        node.type === 'TextInput' && node.props.testID === 'text-field'
      ));
      expect(textField, 'missing native text input').toHaveLength(1);
      const textFieldStyle = flattenStyle(textField[0]!.props.style);
      expect(textFieldStyle.minWidth).toBeGreaterThanOrEqual(minimum);
      expect(textFieldStyle.minHeight).toBeGreaterThanOrEqual(minimum);

      const menuRows = renderer!.root.findAll((node) => (
        node.type === 'Pressable' && node.props.accessibilityRole === 'menuitem'
      ));
      expect(menuRows).toHaveLength(2);
      for (const row of menuRows) {
        const style = resolvePressableStyle(row.props.style);
        expect(style.minWidth).toBeGreaterThanOrEqual(minimum);
        expect(style.minHeight).toBeGreaterThanOrEqual(minimum);
        expect(row.props.hitSlop).toBeUndefined();
      }
    });
  }

  for (const platform of ['desktop', 'web'] as const) {
    it(`retains compact ${platform} list density`, async () => {
      await renderInteractiveFamilies(platform);

      const row = findPressable('list-tight:first');
      expect(resolvePressableStyle(row.props.style).minHeight).toBe(36);
    });
  }

  it('lets a nested plugin surface shadow the host root platform fact', async () => {
    await renderInteractiveFamilies('desktop', 'android');

    const row = findPressable('list-tight:first');
    expect(resolvePressableStyle(row.props.style).minHeight).toBe(36);
  });

  it('applies the projected native text scale exactly once to Text and TextInput', async () => {
    const context = createSurfaceContext({ platform: 'ios', textScale: 2 });
    await renderInteractiveFamilies('ios', undefined, 2);

    const text = renderer!.root.findAll((node) => (
      node.type === 'Text' && node.props.testID === 'scaled-text'
    ));
    expect(text).toHaveLength(1);
    expect(text[0]!.props.allowFontScaling).toBe(false);
    expect(flattenStyle(text[0]!.props.style)).toMatchObject({
      fontSize: context.theme.typography.body.fontSize * 2,
      lineHeight: context.theme.typography.body.lineHeight * 2,
    });

    const textInput = renderer!.root.findAll((node) => (
      node.type === 'TextInput' && node.props.testID === 'text-field'
    ));
    expect(textInput).toHaveLength(1);
    expect(textInput[0]!.props.allowFontScaling).toBe(false);
    expect(flattenStyle(textInput[0]!.props.style)).toMatchObject({
      fontSize: context.theme.typography.body.fontSize * 2,
      lineHeight: context.theme.typography.body.lineHeight * 2,
    });
  });

  it('gives invalid field controls native issue hints and a polite live announcement', async () => {
    const context = createSurfaceContext({ platform: 'ios' });
    await act(async () => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <Form.Field label="Access token" issue="Enter a valid access token.">
            <Form.TextField testID="invalid-token" label="Access token" value="" onChange={() => undefined} />
          </Form.Field>
          <Form.Field label="Mode" issue="Choose a connection mode.">
            <Form.Select
              label="Mode"
              options={[{ value: 'safe', label: 'Safe', testID: 'invalid-mode-option' }]}
              value="safe"
              onChange={() => undefined}
            />
          </Form.Field>
          <Form.Field label="Enabled" issue="Confirm whether the provider is enabled.">
            <Form.Toggle testID="invalid-toggle" label="Enabled" value={false} onChange={() => undefined} />
          </Form.Field>
        </PluginUiProvider>,
      );
    });

    const textInput = renderer!.root.findAll((node) => (
      node.type === 'TextInput' && node.props.testID === 'invalid-token'
    ));
    expect(textInput).toHaveLength(1);
    expect(textInput[0]!.props.accessibilityHint).toBe('Enter a valid access token.');

    for (const testID of ['invalid-mode-option', 'invalid-toggle']) {
      const control = findPressable(testID);
      expect(control.props.accessibilityHint).toBeTruthy();
    }

    const messages = renderer!.root.findAll((node) => (
      node.type === 'Text' && node.props.accessibilityRole === 'alert'
    ));
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.props.nativeID).toBeTruthy();
      expect(message.props.accessibilityLiveRegion).toBe('polite');
    }
  });
});
