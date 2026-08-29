import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({
  OS: 'ios',
  select: <T,>(options: Readonly<{ ios?: T; android?: T; native?: T; default?: T }>) => (
    options.ios ?? options.android ?? options.native ?? options.default
  ),
}));

// React Native is the platform boundary. The public List adapter and the shared
// row owner stay real, so these assertions observe the native frame that
// actually carries a row's accessible name and description.
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

import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { List } from './List.js';
import { PluginUiProvider } from './PluginUiProvider.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

function renderRows(
  children: React.ReactNode,
  context = createSurfaceContext(),
): ReactTestRenderer {
  act(() => {
    renderer = create(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List accessibilityLabel="Repositories">{children}</List>
      </PluginUiProvider>,
    );
  });
  return renderer!;
}

function frame(host: string, testID: string): Record<string, unknown> {
  return renderer!.root.find((node) => node.type === host && node.props.testID === testID)
    .props as Record<string, unknown>;
}

describe('plugin-ui List row accessible description', () => {
  it('describes an actionable row without displacing its title as the accessible name', () => {
    renderRows(
      <List.Item
        testID="repository-row"
        title="happier"
        accessibilityHint="Opens the repository"
        onPress={() => undefined}
      />,
    );

    const row = frame('Pressable', 'repository-row');
    expect(row.accessibilityHint).toBe('Opens the repository');
    // The rendered title still owns the name; a description never becomes one.
    expect(row.accessibilityLabel).toBeUndefined();
  });

  it('describes a static row through the same author contract', () => {
    renderRows(
      <List.Item
        testID="static-row"
        title="happier"
        accessibilityHint="Archived last week"
      />,
    );

    expect(frame('View', 'static-row').accessibilityHint).toBe('Archived last week');
  });

  it('resolves the row name and description through the plugin catalog', () => {
    renderRows(
      <List.Item
        testID="repository-row"
        title="happier"
        accessibilityLabel="happier repository"
        accessibilityLabelKey="acme.repository"
        accessibilityHint="Opens the repository"
        accessibilityHintKey="acme.repository.open"
        onPress={() => undefined}
      />,
      createSurfaceContext({
        translations: {
          'acme.repository': 'Dépôt happier',
          'acme.repository.open': 'Ouvre le dépôt',
        },
      }),
    );

    const row = frame('Pressable', 'repository-row');
    expect(row.accessibilityLabel).toBe('Dépôt happier');
    expect(row.accessibilityHint).toBe('Ouvre le dépôt');
  });

  it('degrades an undeclared row description key to the author fallback rather than the key', () => {
    renderRows(
      <List.Item
        testID="repository-row"
        title="happier"
        accessibilityHint="Opens the repository"
        accessibilityHintKey="acme.repository.open"
        onPress={() => undefined}
      />,
    );

    expect(frame('Pressable', 'repository-row').accessibilityHint).toBe('Opens the repository');
  });
});
