import { describe, expect, it } from 'vitest';

import * as preferencesOwner from './workspaceFileViewerPreferencesV1.js';
import { accountSettingsParse } from './accountSettings.js';
import { applyAccountSettingMutationV1 } from './accountSettingMutationV1.js';

type PreferenceMutationOwner = (settings: Readonly<Record<string, unknown>>, mutation: unknown) => Readonly<Record<string, unknown>>;

function readMutationOwner(): PreferenceMutationOwner {
  const candidate = Reflect.get(preferencesOwner, 'applyWorkspaceFileViewerPreferenceMutationV1');
  expect(typeof candidate).toBe('function');
  return candidate as PreferenceMutationOwner;
}

describe('Workspace file viewer preference mutation owner', () => {
  it('admits an owner-valid map above 16 KiB through semantic Settings mutation and reload without losing unavailable intent', () => {
    const viewer = { kind: 'plugin', pluginId: 'uninstalled.viewer', contributionLocalId: 'reader' } as const;
    const preferences = {
      v: 1,
      selections: Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
        `extension:.${'x'.repeat(250)}${index}`, viewer,
      ])),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(preferences)).byteLength;
    expect(bytes).toBeGreaterThan(16 * 1024);
    expect(bytes).toBeLessThan(preferencesOwner.WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENCODED_BYTES);
    expect(preferencesOwner.WorkspaceFileViewerPreferencesV1Schema.parse(preferences)).toEqual(preferences);

    const selected = preferencesOwner.applyWorkspaceFileViewerPreferenceMutationV1(
      { futurePreference: { keep: true }, workspaceFileViewerPreferencesV1: preferences },
      { kind: 'select', selector: { kind: 'extension', value: '.md' }, viewer },
    );
    const result = applyAccountSettingMutationV1({ futurePreference: { keep: true } }, {
      operations: [{ op: 'set', key: 'workspaceFileViewerPreferencesV1', value: selected.workspaceFileViewerPreferencesV1 }],
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('Expected admitted viewer preferences');
    expect(result.raw.futurePreference).toEqual({ keep: true });
    expect(accountSettingsParse(JSON.parse(JSON.stringify(result.raw))).workspaceFileViewerPreferencesV1)
      .toEqual(selected.workspaceFileViewerPreferencesV1);

    // The domain budget must not widen the enclosing Account document budget.
    expect(applyAccountSettingMutationV1({ futurePreference: 'x'.repeat(512 * 1024) }, {
      operations: [{ op: 'set', key: 'workspaceFileViewerPreferencesV1', value: preferences }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });
  });

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
