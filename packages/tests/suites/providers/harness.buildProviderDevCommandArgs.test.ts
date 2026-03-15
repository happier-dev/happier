import { describe, expect, it } from 'vitest';

import { buildProviderDevCommandArgs } from '../../src/testkit/providers/harness';

describe('providers harness: buildProviderDevCommandArgs', () => {
  it('includes scenario cli args before provider cli extra args', () => {
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
      '--resume',
      'abc',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--started-by',
      'terminal',
    ]);
  });
});

