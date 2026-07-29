import { describe, expect, it } from 'vitest';
import { resolveCodexCliPermissionArgs, resolveYoloCliArgs } from '../../src/testkit/providers/harness';

describe('providers harness: codex permission startup args', () => {
  it('includes permission mode args for codex in yolo mode', () => {
    expect(
      resolveCodexCliPermissionArgs({
        providerSubcommand: 'codex',
        yolo: true,
        scenarioMeta: { permissionMode: 'yolo', permissionModeUpdatedAt: 123 },
      }),
    ).toEqual(['--permission-mode', 'yolo', '--permission-mode-updated-at', '123']);
  });

  it('falls back to yolo mode when metadata is missing', () => {
    expect(
      resolveCodexCliPermissionArgs({
        providerSubcommand: 'codex',
        yolo: true,
        scenarioMeta: {},
      }).slice(0, 3),
    ).toEqual(['--permission-mode', 'yolo', '--permission-mode-updated-at']);
  });

  it('does not add permission mode args for non-codex providers', () => {
    expect(
      resolveCodexCliPermissionArgs({
        providerSubcommand: 'opencode',
        yolo: true,
        scenarioMeta: { permissionMode: 'yolo' },
      }),
    ).toEqual([]);
  });

  it('does not pass legacy --yolo for codex when permission mode args are present', () => {
    expect(
      resolveYoloCliArgs({
        providerSubcommand: 'codex',
        yolo: true,
        hasExplicitPermissionModeArgs: true,
      }),
    ).toEqual([]);
  });

  it('passes --yolo for non-codex providers in yolo mode', () => {
    expect(
      resolveYoloCliArgs({
        providerSubcommand: 'opencode',
        yolo: true,
        hasExplicitPermissionModeArgs: false,
      }),
    ).toEqual(['--yolo']);
  });

  it('passes --yolo for non-codex ACP providers even when permission mode metadata is explicit', () => {
    expect(
      resolveYoloCliArgs({
        providerSubcommand: 'kilo',
        yolo: true,
        hasExplicitPermissionModeArgs: true,
      }),
    ).toEqual(['--yolo']);
  });
});
