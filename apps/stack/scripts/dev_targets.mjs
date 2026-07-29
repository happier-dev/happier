import './utils/env/env.mjs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import {
  loadDevTargetsConfig,
  parseDevTargetsConfig,
  resolveDevTargetsConfigPath,
} from './utils/dev_targets/config.mjs';
import { runDevTargetsDoctor } from './utils/dev_targets/doctor.mjs';

async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((arg) => !arg.startsWith('--'));
  const command = String(positionals[0] ?? '').trim();
  const stackName =
    String(kv.get('--stack') ?? process.env.HAPPIER_STACK_STACK ?? 'main').trim() || 'main';
  const path = resolveDevTargetsConfigPath({ stackName, env: process.env });

  if (wantsHelp(argv, { flags }) || !command) {
    printResult({
      json,
      data: { path, stackName },
      text: [
        '[dev-targets] usage:',
        '  hstack dev-targets path [--stack=NAME]',
        '  hstack dev-targets list [--stack=NAME]',
        '  hstack dev-targets show NAME [--stack=NAME]',
        '  hstack dev-targets doctor [NAME] [--stack=NAME]',
        '  hstack dev-targets add NAME --platform=posix|windows --ssh=ALIAS --repo-dir=PATH --cli-home-dir=PATH [--ssh-config-file=PATH] [--lima-instance=NAME --lima-home=PATH] [--remote-server-port=PORT] [--stack=NAME]',
        '  hstack dev-targets remove NAME [--stack=NAME]',
        '',
        'Mutagen is intentionally user-installed and remains available as the normal `mutagen` CLI.',
      ].join('\n'),
    });
    return;
  }

  const loaded = await loadDevTargetsConfig({ stackName, env: process.env, allowMissing: true });
  if (command === 'path') {
    printResult({ json, data: { path, stackName }, text: path });
    return;
  }
  if (command === 'list') {
    printResult({
      json,
      data: { path, stackName, targets: loaded.config.targets },
      text: loaded.config.targets.length
        ? loaded.config.targets
            .map((target) => `${target.name}\t${target.platform}\t${target.ssh}:${target.repoDir}`)
            .join('\n')
        : '[dev-targets] no targets configured',
    });
    return;
  }
  if (command === 'show') {
    const name = String(positionals[1] ?? '').trim().toLowerCase();
    if (!name) throw new Error('[dev-targets] show requires a target name');
    const target = loaded.config.targets.find((entry) => entry.name === name);
    if (!target) throw new Error(`[dev-targets] target not found: ${name}`);
    printResult({
      json,
      data: { path, stackName, target },
      text: [
        `${target.name}\t${target.platform}`,
        `ssh\t${target.ssh}`,
        ...(target.sshConfigFile ? [`ssh config\t${target.sshConfigFile}`] : []),
        ...(target.limaInstance ? [`Lima\t${target.limaHome}:${target.limaInstance}`] : []),
        `repo\t${target.repoDir}`,
        `CLI home\t${target.cliHomeDir}`,
        ...(target.remoteServerPort ? [`remote server port\t${target.remoteServerPort}`] : []),
      ].join('\n'),
    });
    return;
  }
  if (command === 'doctor') {
    const requestedName = String(positionals[1] ?? '').trim().toLowerCase();
    const targets = requestedName
      ? loaded.config.targets.filter((target) => target.name === requestedName)
      : loaded.config.targets;
    if (requestedName && targets.length === 0) {
      throw new Error(`[dev-targets] target not found: ${requestedName}`);
    }
    const diagnosis = await runDevTargetsDoctor({ targets, env: process.env });
    printResult({
      json,
      data: { path, stackName, ...diagnosis },
      text: [
        `[dev-targets] Mutagen\t${diagnosis.mutagen.ok ? 'ok' : 'failed'}`,
        ...diagnosis.targets.map(
          (target) => `[dev-targets] ${target.name}\t${target.ok ? 'ok' : 'failed'}`,
        ),
        ...(diagnosis.targets.length === 0 ? ['[dev-targets] no targets configured'] : []),
      ].join('\n'),
    });
    if (!diagnosis.ok) process.exitCode = 1;
    return;
  }
  if (command === 'add') {
    const name = String(positionals[1] ?? '').trim();
    if (!name) throw new Error('[dev-targets] add requires a target name');
    const candidate = {
      name,
      platform: kv.get('--platform'),
      ssh: kv.get('--ssh'),
      sshConfigFile: kv.get('--ssh-config-file') ?? null,
      limaInstance: kv.get('--lima-instance') ?? null,
      limaHome: kv.get('--lima-home') ?? null,
      repoDir: kv.get('--repo-dir'),
      cliHomeDir: kv.get('--cli-home-dir'),
      remoteServerPort: kv.get('--remote-server-port') ?? null,
    };
    const remaining = loaded.config.targets.filter(
      (target) => target.name.toLowerCase() !== name.toLowerCase(),
    );
    const config = parseDevTargetsConfig({ version: 1, targets: [...remaining, candidate] });
    await writeConfig(path, config);
    const target = config.targets.find((entry) => entry.name === name.toLowerCase());
    printResult({
      json,
      data: { path, stackName, target },
      text: `[dev-targets] configured ${target.name} for stack ${stackName}\n[dev-targets] ${path}`,
    });
    return;
  }
  if (command === 'remove' || command === 'rm') {
    const name = String(positionals[1] ?? '').trim().toLowerCase();
    if (!name) throw new Error('[dev-targets] remove requires a target name');
    const targets = loaded.config.targets.filter((target) => target.name !== name);
    const removed = targets.length !== loaded.config.targets.length;
    const config = parseDevTargetsConfig({ version: 1, targets });
    await writeConfig(path, config);
    printResult({
      json,
      data: { path, stackName, removed, name },
      text: removed
        ? `[dev-targets] removed ${name} from stack ${stackName}`
        : `[dev-targets] target not found: ${name}`,
    });
    return;
  }
  throw new Error(`[dev-targets] unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
