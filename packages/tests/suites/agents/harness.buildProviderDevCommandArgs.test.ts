import { describe, expect, it } from 'vitest';

import {
  buildProviderCliCommandArgs,
  buildProviderDevCommandArgs,
} from '../../src/testkit/providers/harness';

describe('providers harness: buildProviderDevCommandArgs', () => {
  it('includes provider cli extra args before scenario cli args (so scenarios can override provider defaults)', () => {
    const args = buildProviderDevCommandArgs({
      providerSubcommand: 'claude',
      sessionId: 'sess_1',
      yoloCliArgs: ['--yolo'],
      permissionCliArgs: ['--permission-mode', 'default'],
      modelCliArgs: ['--model', 'x'],
      extraCliArgs: ['--resume', 'abc'],
      scenarioCliArgs: ['--mcp-config', '{"mcpServers":{}}'],
      providerCliExtraArgs: ['--started-by', 'terminal'],
    });

    expect(args).toEqual([
      '-s',
      'workspace',
      '@happier-dev/cli',
      'dev',
      'claude',
      '--existing-session',
      'sess_1',
      '--yolo',
      '--permission-mode',
      'default',
      '--model',
      'x',
      '--started-by',
      'terminal',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--resume',
      'abc',
    ]);
  });

  it('builds direct CLI source-entrypoint args without the yarn workspace dev wrapper', () => {
    const args = buildProviderCliCommandArgs({
      providerSubcommand: 'grok',
      sessionId: 'sess_2',
      yoloCliArgs: ['--yolo'],
      permissionCliArgs: [],
      modelCliArgs: [],
      extraCliArgs: [],
      scenarioCliArgs: [],
      providerCliExtraArgs: [],
    });

    expect(args).toEqual([
      'grok',
      '--existing-session',
      'sess_2',
      '--yolo',
    ]);
  });
});
