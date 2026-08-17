import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import { accountSettingsParse } from './accountSettings.js';

type ParseableSchema = Readonly<{
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}>;

function readSchema(name: string): ParseableSchema {
  const value = Reflect.get(protocol, name);
  expect(value).toBeDefined();
  expect(typeof Reflect.get(value, 'parse')).toBe('function');
  expect(typeof Reflect.get(value, 'safeParse')).toBe('function');
  return value as ParseableSchema;
}

function extensionSelectorKey(index: number): string {
  const suffix = index.toString(36);
  return `extension:.${'x'.repeat(255 - suffix.length)}${suffix}`;
}

describe('WorkspaceFileViewerPreferencesV1', () => {
  const pluginViewer = {
    kind: 'plugin',
    pluginId: 'acme.viewer',
    contributionLocalId: 'markdown',
  } as const;

  it('persists only canonical SDK selector keys to qualified viewer identities', () => {
    const schema = readSchema('WorkspaceFileViewerPreferencesV1Schema');

    expect(schema.parse({
      v: 1,
      selections: {
        'mime:text/markdown': pluginViewer,
        'extension:.md': { kind: 'builtin' },
        'class:text': { kind: 'builtin' },
      },
    })).toEqual({
      v: 1,
      selections: {
        'mime:text/markdown': pluginViewer,
        'extension:.md': { kind: 'builtin' },
        'class:text': { kind: 'builtin' },
      },
    });

    expect(schema.safeParse({
      v: 1,
      selections: {
        'MIME:TEXT/MARKDOWN': pluginViewer,
      },
    }).success).toBe(false);
    expect(schema.safeParse({
      v: 1,
      selections: {
        'mime:text/markdown': pluginViewer,
        'mime:TEXT/MARKDOWN': { kind: 'builtin' },
      },
    }).success).toBe(false);
    expect(schema.safeParse({
      v: 1,
      selections: {
        'mime:text/markdown': {
          ...pluginViewer,
          path: '/private/workspace/README.md',
        },
      },
    }).success).toBe(false);
  });

  it('defaults in the canonical Account Settings record and rejects unbounded preference state', () => {
    const schema = readSchema('WorkspaceFileViewerPreferencesV1Schema');

    expect((accountSettingsParse({}) as Record<string, unknown>).workspaceFileViewerPreferencesV1).toEqual({
      v: 1,
      selections: {},
    });

    const tooManySelections = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [extensionSelectorKey(index), { kind: 'builtin' }]),
    );
    expect(schema.safeParse({ v: 1, selections: tooManySelections }).success).toBe(false);

    const oversizedViewer = {
      kind: 'plugin',
      pluginId: `acme.${'x'.repeat(251)}`,
      contributionLocalId: `a${'-a'.repeat(127)}`,
    };
    const oversizedSelections = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [extensionSelectorKey(index), oversizedViewer]),
    );
    expect(schema.safeParse({ v: 1, selections: oversizedSelections }).success).toBe(false);
  });
});
