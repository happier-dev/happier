/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFormsCommonModuleMocks } from '../forms/formsTestHelpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installFormsCommonModuleMocks({
  reactNative: async () => await vi.importActual('react-native-web'),
});

// The app `Text` only adds font scaling from local settings (a storage boundary); the host text is under test.
vi.mock('@/components/ui/text/Text', async () => {
  const rnw =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return { Text: rnw.Text, TextInput: rnw.TextInput };
});

const { FieldLayout, FieldValue } = await import('./FieldRow');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('a page fact with a long value', () => {
  it('wraps a path without spaces at its separators inside the value column', async () => {
    const path =
      '/home/reviewer/.happier/workspaces/harbor-ledger/packages/deploy/src/environments/production/secrets.json';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <FieldLayout label="Path" columns>
          <FieldValue value={path} />
        </FieldLayout>,
      );
    });

    const value = [...container.querySelectorAll('*')].find(
      (node) => node.textContent === path && [...node.children].every((child) => child.tagName === 'WBR'),
    );
    expect(value).toBeTruthy();
    expect(getComputedStyle(value!).overflowWrap).toBe('anywhere');
    // It breaks after a separator, never inside a name; the copied text stays the path.
    const segments = value!.innerHTML.split('<wbr>');
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.slice(0, -1).every((segment) => segment.endsWith('/'))).toBe(true);
  });
});
