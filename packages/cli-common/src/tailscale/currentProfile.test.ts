import { describe, expect, it } from 'vitest';
import { parseTailscaleCurrentProfileId } from './statusSnapshot.js';
import { runTailscaleCurrentProfileId, type TailscaleCommandRequest } from './commandRunner.js';
import { classifyRelayAccessDiagnosticCode } from '../relayAccess/diagnostics.js';

// External contract: official Tailscale v1.104.2, switch.go listProfilesJSON.
// No expected-profile selector or product-authority contract is inferred here.
describe('Tailscale current profile observation', () => {
  it('takes identity from the uniquely selected native profile rather than its nickname or tailnet label', () => {
    expect(parseTailscaleCurrentProfileId([
      { id: 'profile-old', nickname: 'work', tailnet: 'same-label', account: 'old@example.test', selected: false },
      { id: 'profile-active', nickname: 'work', tailnet: 'same-label', account: 'current@example.test', selected: true,
        ignoredNativeField: { credential: 'not-an-observation' } },
    ])).toBe('profile-active');
  });

  it.each([
    [], {}, null,
    [{ id: 'other', selected: false }],
    [{ id: '', selected: true }],
    [{ id: 'unknown', selected: 'true' }],
    [{ id: 'one', selected: true }, { id: 'two', selected: true }],
    [{ id: '', selected: true }, { id: 'two', selected: true }],
  ])('leaves missing or ambiguous profile evidence unknown: %j', value => {
    expect(parseTailscaleCurrentProfileId(value)).toBeNull();
  });

  it('uses the same selected native socket and reads only profile status', async () => {
    const commands: TailscaleCommandRequest[] = [];
    const profileId = await runTailscaleCurrentProfileId({ tailscaleBin: '/fixture/tailscale', socketPath: '/run/selected-tailscaled.sock' }, {
      runCommand: async request => {
        commands.push(request);
        return { command: request.command, args: request.args, exitCode: 0, stderr: '', stdout: JSON.stringify([
          { id: 'selected-native-profile', nickname: 'work', tailnet: 'example.test', account: 'owner@example.test', selected: true },
        ]) };
      },
    });
    expect(profileId).toBe('selected-native-profile');
    expect(commands.map(command => command.args)).toEqual([
      ['--socket=/run/selected-tailscaled.sock', 'switch', '--list', '--json'],
    ]);
  });

  it('does not treat success-looking output from an unsupported or failed CLI read as a selected profile', async () => {
    await expect(runTailscaleCurrentProfileId({ tailscaleBin: '/fixture/tailscale' }, {
      runCommand: async request => ({ command: request.command, args: request.args, exitCode: 1,
        stdout: '[{"id":"not-proof","selected":true}]', stderr: 'unsupported flag' }),
    })).rejects.toMatchObject({ name: 'TailscaleCommandError' });
  });

  it('classifies the non-operator profiles refusal as the typed operator authorization failure', async () => {
    // Native Linux Tailscale 1.104.6 stderr for `switch --list --json` run by a non-operator user (exit 1),
    // observed on nl3 2026-11-22 (BL2-NATIVE C65): .project/tmp/BL2-NATIVE-1118/r200/c65-switch-nonoperator.txt.
    const stderr = "Access denied: profiles access denied\n\nUse 'sudo tailscale switch --list --json'.\n"
      + "To not require root, use 'sudo tailscale set --operator=$USER' once.\n";
    const caught = await runTailscaleCurrentProfileId({ tailscaleBin: '/fixture/tailscale' }, {
      runCommand: async request => ({ command: request.command, args: request.args, exitCode: 1, stdout: '', stderr }),
    }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ name: 'TailscaleCommandError', stderrClass: 'operator_authorization_refused',
      failure: { code: 'tailscale_operator_authorization_refused', retryable: false } });
    expect(classifyRelayAccessDiagnosticCode(caught)).toBe('tailscale_operator_authorization_refused');
  });

  it('preserves the containing operation cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('operation cancelled');
    await expect(runTailscaleCurrentProfileId({ tailscaleBin: '/fixture/tailscale', signal: controller.signal }, {
      runCommand: async request => {
        controller.abort(reason);
        return { command: request.command, args: request.args, exitCode: 0, stdout: '[]', stderr: '' };
      },
    })).rejects.toBe(reason);
  });
});
