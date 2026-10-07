import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PI_PREFLIGHT_SESSION_CONTROLS } from './models.js';

// Pi's executable and extension API are the external boundary; declaration preparation,
// generated extension source and native-observation parsing remain real.
function runNativeBoundary(outcome: 'commands' | 'empty' | 'unsupported' | 'failure' | 'malformed' | 'missing') {
  const declaration = PI_PREFLIGHT_SESSION_CONTROLS;
  expect(declaration.catalogs).toBeDefined();
  const catalog = declaration.catalogs;
  if (!catalog) throw new Error('Pi native catalog declaration is missing');
  const directory = mkdtempSync(join(tmpdir(), 'happier-pi-catalog-boundary-'));
  try {
    const args = catalog.command.prepareCommand?.({ accountSettings: null, environment: {} }).args ?? catalog.command.args;
    const materialized = args.map((arg, index) => {
      if (typeof arg === 'string') return arg;
      if (arg.kind !== 'temporaryTextFile') throw new Error('Unexpected native-boundary fixture path');
      const path = join(directory, `extension-${index}${arg.suffix}`);
      writeFileSync(path, arg.contents);
      return path;
    });
    const script = join(directory, 'pi.mjs');
    writeFileSync(script, `
      import { pathToFileURL } from 'node:url';
      const args = process.argv.slice(2);
      if (args[args.indexOf('--mode') + 1] !== 'json' || !args.includes('--no-session')) process.exit(2);
      const handlers = new Map();
      const commands = ${JSON.stringify(outcome)} === 'empty' ? [] : [
        {name:'Mixed-Case', description:'Native extension', source:'extension'},
        {name:'design-template', description:'Native template', source:'prompt'},
        {name:'skill:design', description:'Native slash skill', source:'skill'},
      ];
      const pi = {
        on: (event, handler) => handlers.set(event, handler),
        ...(${JSON.stringify(outcome)} === 'unsupported' ? {} : { getCommands: () => {
          if (${JSON.stringify(outcome)} === 'failure') throw Error('native catalog unavailable');
          return ${JSON.stringify(outcome)} === 'malformed' ? {} : commands;
        }}),
      };
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--extension') (await import(pathToFileURL(args[++index]))).default(pi);
      }
      if (${JSON.stringify(outcome)} !== 'missing') await handlers.get('session_start')({}, {});
    `);
    const result = spawnSync(process.execPath, [script, ...materialized], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    return catalog.parseOutput({ ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: result.status });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Pi native preflight command catalogs', () => {
  it('observes native extensions, prompt templates and slash skills without inventing typed skill mentions', async () => {
    expect(await runNativeBoundary('commands')).toEqual({
      commands: [
        { name: 'Mixed-Case', description: 'Native extension', source: 'extension' },
        { name: 'design-template', description: 'Native template', source: 'prompt' },
        { name: 'skill:design', description: 'Native slash skill', source: 'skill' },
      ],
      skills: null,
    });
  });

  it('preserves a successfully observed empty command catalog', async () => {
    expect(await runNativeBoundary('empty')).toEqual({ commands: [], skills: null });
  });

  it.each(['unsupported', 'failure', 'malformed', 'missing'] as const)(
    'reports %s native observation as unavailable despite a successful process exit', async (outcome) => {
      await expect(Promise.resolve().then(() => runNativeBoundary(outcome))).rejects.toMatchObject({ name: 'Error' });
    },
  );

  it('rejects command output from a failed native process', async () => {
    const declaration = PI_PREFLIGHT_SESSION_CONTROLS;
    expect(declaration.catalogs).toBeDefined();
    if (!declaration.catalogs) return;
    await expect(Promise.resolve().then(() => declaration.catalogs?.parseOutput({
      ok: false, stdout: '', exitCode: 1,
      stderr: JSON.stringify({ type: 'happier-pi-command-catalog', commands: [] }),
    }))).rejects.toMatchObject({ name: 'Error' });
  });
});
