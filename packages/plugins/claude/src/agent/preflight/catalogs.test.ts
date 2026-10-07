import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentPreflightSessionControlsCommandResultV1,
  AgentPreflightSessionControlsCommandV1,
  AgentPreflightSessionControlsProbeInputV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

const nativeFixture = String.raw`
const readline = require('node:readline');
const requests = [];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  requests.push(JSON.parse(line));
}).on('close', () => {
  const request = requests.find((message) => message.type === 'control_request' && message.request.subtype === 'initialize');
  process.stderr.write(JSON.stringify({ requests, argv: process.argv.slice(2) }));
  if (!request) process.exit(2);
  const mode = process.env.CLAUDE_CATALOG_FIXTURE_MODE;
  const response = mode === 'error'
    ? { subtype: 'error', request_id: request.request_id, error: 'Native initialization unavailable' }
    : { subtype: 'success', request_id: mode === 'wrong-id' ? 'foreign-request' : request.request_id,
        response: mode === 'missing-commands' ? {} : { commands: mode === 'empty' ? [] : [{ name: 'review', description: 'Review changes', argumentHint: '' }] } };
  const output = JSON.stringify({ type: 'control_response', response });
  process.stdout.write(mode === 'truncated' ? output.slice(0, -5) : output + '\n');
});
`;

async function runNativeCommand(
  command: AgentPreflightSessionControlsCommandV1,
  mode: string,
  input: AgentPreflightSessionControlsProbeInputV1 = { accountSettings: null, environment: {} },
) {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-catalog-declaration-'));
  try {
    const executable = join(cwd, 'claude-fixture.cjs');
    await writeFile(executable, nativeFixture);
    const prepared = command.prepareCommand?.(input);
    const args = prepared?.args ?? command.args;
    if (!args.every((arg): arg is string => typeof arg === 'string')) throw new Error('Fixture expects native string arguments');
    // A real external CLI subprocess observes the declaration's stdin and arguments.
    const child = spawn(process.execPath, [executable, ...args], {
      cwd,
      env: { ...process.env, CLAUDE_CATALOG_FIXTURE_MODE: mode },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
        child.stdin.end(command.stdin);
      });
      return { result: { ok: exitCode === 0, exitCode, stdout, stderr } satisfies AgentPreflightSessionControlsCommandResultV1,
        transport: JSON.parse(stderr) as { requests: unknown[]; argv: string[] } };
    } finally {
      child.kill();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function withCatalogDeclaration(inspect: (catalogs: Readonly<{
  command: AgentPreflightSessionControlsCommandV1;
  parseOutput(result: AgentPreflightSessionControlsCommandResultV1): unknown | Promise<unknown>;
}>) => Promise<void>) {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  try {
    const contribution = activation.registration('agents', 'claude')?.preflightSessionControls;
    expect(contribution?.catalogs).toBeDefined();
    if (!contribution?.catalogs || !('parseOutput' in contribution.catalogs)) throw new Error('Claude native catalog declaration is missing');
    await inspect(contribution.catalogs);
  } finally {
    await activation.dispose();
  }
}

describe('Claude declared native catalogs', () => {
  it.each([
    { mode: 'commands', commands: [{ name: 'review', description: 'Review changes', argumentHint: '' }] },
    { mode: 'empty', commands: [] },
  ])('advertises $mode without a user prompt and distinguishes unsupported skill mentions', async ({ mode, commands }) => {
    await withCatalogDeclaration(async (catalogs) => {
      const { result, transport } = await runNativeCommand(catalogs.command, mode);
      expect(await catalogs.parseOutput(result)).toEqual({ commands, skills: null });
      expect(transport.requests).toEqual([{
        type: 'control_request', request_id: expect.any(String), request: { subtype: 'initialize' },
      }]);
      expect(transport.argv).toEqual(expect.arrayContaining([
        '--print', '--input-format', 'stream-json', '--output-format', '--verbose', '--no-session-persistence',
      ]));
    });
  });

  it('uses persisted Agent settings before Account-root defaults at the native process boundary', async () => {
    await withCatalogDeclaration(async (catalogs) => {
      const { transport } = await runNativeCommand(catalogs.command, 'commands', {
        accountSettings: { claudeRemoteSettingSourcesV2: ['user'] },
        environment: {},
        pluginSettings: { account: { claudeRemoteSettingSources: 'none' } },
      });
      expect(transport.argv.slice(-2)).toEqual(['--setting-sources', '']);
    });
  });

  it.each(['error', 'wrong-id', 'missing-commands', 'truncated'])('rejects %s native output despite exit zero', async (mode) => {
    await withCatalogDeclaration(async (catalogs) => {
      const { result } = await runNativeCommand(catalogs.command, mode);
      expect(result.exitCode).toBe(0);
      await expect(Promise.resolve().then(() => catalogs.parseOutput(result))).rejects.toThrow();
    });
  });
});
