import { describe, expect, it } from 'vitest';

import * as preferencesOwner from './workspaceFileViewerPreferencesV1.js';

type PreferenceMutationOwner = (settings: Readonly<Record<string, unknown>>, mutation: unknown) => Readonly<Record<string, unknown>>;

function readMutationOwner(): PreferenceMutationOwner {
  const candidate = Reflect.get(preferencesOwner, 'applyWorkspaceFileViewerPreferenceMutationV1');
  expect(typeof candidate).toBe('function');
  return candidate as PreferenceMutationOwner;
}

describe('Workspace file viewer preference mutation owner', () => {
  it('normalizes one selector, retains qualified unavailable viewer intent, and clears without writing a synthetic fallback', () => {
    const apply = readMutationOwner();
    const initial = {
      preservedFutureSetting: { keep: true },
      workspaceFileViewerPreferencesV1: {
        v: 1,
        selections: {
          'extension:.md': { kind: 'builtin' },
        },
      },
    };

    const selected = apply(initial, {
      kind: 'select',
      selector: { kind: 'mime', value: ' TEXT/MARKDOWN ' },
      viewer: {
        kind: 'plugin',
        pluginId: 'acme.viewer',
        contributionLocalId: 'markdown',
      },
    });

    expect(selected).toEqual({
      preservedFutureSetting: { keep: true },
      workspaceFileViewerPreferencesV1: {
        v: 1,
        selections: {
          'extension:.md': { kind: 'builtin' },
          'mime:text/markdown': {
            kind: 'plugin',
            pluginId: 'acme.viewer',
            contributionLocalId: 'markdown',
          },
        },
      },
    });

    expect(apply(selected, {
      kind: 'clear',
      selector: { kind: 'mime', value: 'text/markdown' },
    })).toEqual({
      preservedFutureSetting: { keep: true },
      workspaceFileViewerPreferencesV1: {
        v: 1,
        selections: {
          'extension:.md': { kind: 'builtin' },
        },
      },
    });
  });
});
