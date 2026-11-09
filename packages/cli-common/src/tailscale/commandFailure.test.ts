import { describe, expect, it } from 'vitest';

import {
  runTailscaleFunnelDisable,
  runTailscaleFunnelEnable,
  runTailscaleFunnelStatus,
  runTailscaleServeDisable,
  runTailscaleServeEnable,
  runTailscaleServeReset,
  runTailscaleServeStatus,
  TailscaleCommandError,
  type TailscaleCommandRunner,
} from './commandRunner.js';

// Native Linux 1.104.2 stderr: .project/tmp/RELAYHOST/native-disable.stderr.
const refusal = "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket";
const params = { tailscaleBin: '/fixture/tailscale', upstreamUrl: 'http://127.0.0.1:3005' };

describe('Tailscale command authorization failure', () => {
  it.each([
    ['serve enable', runTailscaleServeEnable],
    ['funnel enable', runTailscaleFunnelEnable],
    ['serve disable', runTailscaleServeDisable],
    ['funnel disable', runTailscaleFunnelDisable],
    ['serve reset', runTailscaleServeReset],
    ['serve status', runTailscaleServeStatus],
    ['funnel status', runTailscaleFunnelStatus],
  ] as const)('classifies native refusal once for %s without retry or diagnostic disclosure', async (_name, run) => {
    const requests: string[][] = [];
    const runCommand: TailscaleCommandRunner = async request => {
      requests.push([...request.args]);
      return { ...request, exitCode: 1, stdout: '', stderr: `${refusal}\n/private/alice token=secret-value` };
    };
    let caught: unknown;
    try { await run(params, { runCommand }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TailscaleCommandError);
    expect(caught).toMatchObject({ failure: {
      code: 'tailscale_operator_authorization_refused', retryable: false,
      remediation: expect.stringContaining('sudo'),
    } });
    expect(caught).toMatchObject({ stderrClass: 'operator_authorization_refused' });
    expect(requests).toHaveLength(1);
    if (!(caught instanceof TailscaleCommandError)) throw new Error('Expected native command failure');
    const presentation = JSON.stringify({ message: caught.message, failure: caught.failure });
    expect(presentation).toContain('usermod --comment');
    expect(presentation).toContain('tailscale set --operator');
    expect(presentation).not.toContain('/private/alice');
    expect(presentation).not.toContain('secret-value');
  });

  it('also classifies rejected native/SSH results and gives refusal precedence over an approval URL', async () => {
    const error = new TailscaleCommandError('raw secret-value', { command: params.tailscaleBin,
      args: ['serve', '--bg'], exitCode: 1, stdout: 'https://login.tailscale.com/f/serve?node=secret-value', stderr: refusal });
    await expect(runTailscaleServeEnable(params, { runCommand: async () => { throw error; } }))
      .rejects.toMatchObject({ failure: { code: 'tailscale_operator_authorization_refused', retryable: false } });
    expect(error.message).not.toContain('secret-value');
  });

  it.each([runTailscaleServeEnable, runTailscaleFunnelEnable])('preserves refusal from enable readback rather than returning an empty success', async run => {
    const runCommand: TailscaleCommandRunner = async request => ({ ...request,
      exitCode: request.args[1] === 'status' ? 1 : 0, stdout: '',
      stderr: request.args[1] === 'status' ? refusal : '',
    });
    await expect(run(params, { runCommand }))
      .rejects.toMatchObject({ failure: { code: 'tailscale_operator_authorization_refused', retryable: false } });
  });

  it('does not infer the specific operator cause from a generic 401 or successful output', async () => {
    const result = { command: params.tailscaleBin, args: ['serve', 'status'], exitCode: 1, stdout: '', stderr: '401 Unauthorized' };
    expect(new TailscaleCommandError('Other failure', result)).toMatchObject({ failure: null, message: 'Other failure' });
    expect(new TailscaleCommandError('Success text', { ...result, exitCode: 0, stderr: refusal }))
      .toMatchObject({ failure: null, message: 'Success text' });
  });
});
