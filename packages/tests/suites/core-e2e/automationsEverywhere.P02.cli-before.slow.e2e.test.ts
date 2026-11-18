import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

describe('AE.P02 public CLI before check', () => {
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('refuses the public CLI --yes Machine command before its effect when a saved wait check fails', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-cli-before-'));
    fixture = await startProjectDaemonFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const cli = (label: string, command: string) => runCliJson({ testDir, cliHomeDir: machine.homeDir,
      serverUrl: fixture!.server.baseUrl, webappUrl: fixture!.server.baseUrl, label,
      env: { ...process.env, NODE_OPTIONS: fixture!.sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' },
      launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true }, acceptedExitCodes: [0, 1],
      args: ['--server-url', fixture!.server.baseUrl, 'actions', 'invoke', 'machines.command.run',
        '--machine-id', machine.target.machineId, '--project-directory', machine.workspaceDir,
        '--input-json', JSON.stringify({ command }), '--yes', '--json'] });
    expect(await cli('before-control', 'echo CLI_CONTROL')).toMatchObject({ ok: true, data: { exitCode: 0 } });
    const linked = await actor.executeAsPerson('workflow.trigger.add', {
      actionApproval: 'automatic', project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [
        { kind: 'action', id: 'check', actionId: 'machines.command.run', input: {
          command: { kind: 'literal', value: process.platform === 'win32'
            ? 'powershell -NoProfile -Command "[IO.File]::WriteAllText(\'cli-check.txt\', \'CHECK_EXECUTED\'); exit 7"'
            : 'echo CHECK_EXECUTED > cli-check.txt; exit 7' },
        } },
      ] } },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'refuse', enabled: true,
        actionIds: ['machines.command.run'] },
    });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    const refused = await cli('before-refused', 'echo FORBIDDEN > cli-effect.txt');
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false,
      error: { code: 'action_interception_rejected', effectAttempted: false } });
    await expect(access(join(machine.workspaceDir, 'cli-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(machine.workspaceDir, 'cli-check.txt'), 'utf8')).toContain('CHECK_EXECUTED');
  }, 0);

});
