import chalk from 'chalk';

import { configuration, reloadConfiguration } from '@/configuration';
import {
  addServerProfile,
  getActiveServerProfile,
  getServerProfile,
  listServerProfiles,
  removeServerProfile,
  useServerProfile,
} from '@/server/serverProfiles';
import { probeServerVersion } from '@/server/serverTest';

import {
  argvValue,
  defaultNameFromUrl,
  defaultWebappUrlFromServerUrl,
  isInteractiveTerminal,
  normalizeUrlOrThrow,
  parseYesNoWithDefault,
  promptInput,
  runCliAction,
} from './commandUtilities';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';

export async function runServerSubcommand(subcommand: string, args: string[]): Promise<boolean> {
  switch (subcommand) {
    case 'list':
      await cmdList(args.slice(1));
      return true;
    case 'current':
      await cmdCurrent(args.slice(1));
      return true;
    case 'add':
      await cmdAdd(args.slice(1));
      return true;
    case 'use':
      await cmdUse(args.slice(1));
      return true;
    case 'remove':
      await cmdRemove(args.slice(1));
      return true;
    case 'test':
      await cmdTest(args.slice(1));
      return true;
    case 'set':
      await cmdSet(args.slice(1));
      return true;
    default:
      return false;
  }
}

type ServerProfileSummary = Readonly<{
  id: string;
  name: string;
  serverUrl: string;
  webappUrl: string;
  lastUsedAt?: number;
}>;

function summarizeProfile(p: any): ServerProfileSummary {
  const out: ServerProfileSummary = {
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    serverUrl: String(p.serverUrl ?? ''),
    webappUrl: String(p.webappUrl ?? ''),
    ...(typeof p.lastUsedAt === 'number' ? { lastUsedAt: p.lastUsedAt } : {}),
  };
  return out;
}

async function cmdList(args: string[]): Promise<void> {
  const active = await getActiveServerProfile();
  const profiles = await listServerProfiles();
  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'server_list',
      data: {
        activeServerId: active.id,
        profiles: profiles.map(summarizeProfile),
      },
    });
    return;
  }
  if (profiles.length === 0) {
    console.log(chalk.gray('(no server profiles configured)'));
    return;
  }

  for (const p of profiles.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))) {
    const marker = p.id === active.id ? chalk.green('✓') : ' ';
    console.log(`${marker} ${chalk.bold(p.name)} (${p.id})`);
    console.log(`    ${chalk.gray('server:')} ${p.serverUrl}`);
    console.log(`    ${chalk.gray('webapp:')} ${p.webappUrl}`);
  }
}

async function cmdCurrent(args: string[]): Promise<void> {
  const active = await getActiveServerProfile();
  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'server_current',
      data: { active: summarizeProfile(active) },
    });
    return;
  }
  console.log(chalk.bold('Active server'));
  console.log(`${chalk.gray('name:')}   ${active.name}`);
  console.log(`${chalk.gray('id:')}     ${active.id}`);
  console.log(`${chalk.gray('server:')} ${active.serverUrl}`);
  console.log(`${chalk.gray('webapp:')} ${active.webappUrl}`);
}

async function cmdAdd(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const interactive = isInteractiveTerminal() && !json;
  let name = argvValue(args, '--name');
  let serverUrlRaw = argvValue(args, '--server-url');
  let webappUrlRaw = argvValue(args, '--webapp-url');
  const hasUse = args.includes('--use');
  const hasNoUse = args.includes('--no-use');
  let shouldUse = hasUse;
  let startDaemon = args.includes('--start-daemon');
  let installService = args.includes('--install-service');

  if (json && (startDaemon || installService)) {
    const err: any = new Error('Unsupported in --json mode: --start-daemon/--install-service');
    err.code = 'unsupported';
    throw err;
  }

  if (hasUse && hasNoUse) {
    throw new Error('Cannot combine --use and --no-use');
  }

  if (!interactive) {
    if (!name || !serverUrlRaw) {
      throw new Error(
        [
          'Non-interactive mode: missing required arguments for `happier server add`.',
          'Provide: --name <name> --server-url <url> [--webapp-url <url>] [--use].',
          'Optional actions: --start-daemon, --install-service.',
        ].join(' '),
      );
    }
  } else {
    if (!serverUrlRaw) {
      serverUrlRaw = (await promptInput('Server URL (https://...): ')).trim();
    }
    const serverUrlForDefaults = normalizeUrlOrThrow(serverUrlRaw, '--server-url');
    if (!name) {
      const defaultName = defaultNameFromUrl(serverUrlForDefaults);
      const answer = await promptInput(`Server profile name [${defaultName}]: `);
      name = answer.trim() || defaultName;
    }
    if (!hasUse && !hasNoUse) {
      const answer = await promptInput('Use this server as active now? [Y/n]: ');
      shouldUse = parseYesNoWithDefault(answer, true);
    } else if (hasNoUse) {
      shouldUse = false;
    }
  }

  if (!name) throw new Error('Missing --name');
  const serverUrl = normalizeUrlOrThrow(serverUrlRaw, '--server-url');
  const webappUrl = webappUrlRaw
    ? normalizeUrlOrThrow(webappUrlRaw, '--webapp-url')
    : defaultWebappUrlFromServerUrl(serverUrl);

  const created = await addServerProfile({ name, serverUrl, webappUrl, use: shouldUse });
  const active = shouldUse ? created : await getActiveServerProfile();

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'server_add',
      data: { created: summarizeProfile(created), active: summarizeProfile(active), used: shouldUse },
    });
    return;
  }

  if (shouldUse) reloadConfiguration();
  console.log(chalk.green(`✓ Saved server profile: ${created.name} (${created.id})`));
  const prefix = `happier --server ${created.id}`;
  if (shouldUse) {
    console.log(chalk.gray(`  Active server is now: ${created.serverUrl}`));
  }

  if (!interactive || shouldUse) {
    console.log('');
    console.log(chalk.bold('Next steps (optional)'));
    console.log(chalk.gray(`  Start daemon: ${prefix} daemon start`));
    console.log(chalk.gray(`  Install background service: ${prefix} daemon service install`));
  }

  if (installService) {
    await runCliAction(['--server', created.id, 'daemon', 'service', 'install']);
  }
  if (startDaemon && !installService) {
    await runCliAction(['--server', created.id, 'daemon', 'start']);
  }
}

async function cmdUse(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const identifier = String(args[0] ?? '').trim();
  if (!identifier) throw new Error('Missing server id/name');
  const active = await useServerProfile(identifier);
  reloadConfiguration();
  if (json) {
    printJsonEnvelope({ ok: true, kind: 'server_use', data: { active: summarizeProfile(active) } });
    return;
  }
  console.log(chalk.green(`✓ Active server: ${active.name} (${active.id})`));
  console.log(chalk.gray(`  ${active.serverUrl}`));
}

async function cmdRemove(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const identifier = String(args[0] ?? '').trim();
  if (!identifier) throw new Error('Missing server id/name');
  const force = args.includes('--force');
  const out = await removeServerProfile(identifier, { force });
  reloadConfiguration();
  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'server_remove',
      data: { removed: summarizeProfile(out.removed), active: summarizeProfile(out.active) },
    });
    return;
  }
  console.log(chalk.green(`✓ Removed server profile: ${out.removed.name} (${out.removed.id})`));
  console.log(chalk.gray(`  Active server: ${out.active.name} (${out.active.id})`));
}

async function cmdTest(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const nonFlagArgs = args.filter((a) => !String(a).startsWith('-'));
  const identifier = String(nonFlagArgs[0] ?? '').trim();
  const profile = identifier ? await getServerProfile(identifier) : await getActiveServerProfile();
  const result = await probeServerVersion(profile.serverUrl);
  if (json) {
    printJsonEnvelope(
      {
        ok: true,
        kind: 'server_test',
        data: result,
      },
      { exitCode: result.ok ? 0 : 1 },
    );
    return;
  }
  if (!result.ok) {
    console.error(chalk.red(`✗ Server test failed: ${profile.serverUrl}`));
    console.error(chalk.gray(`  url: ${result.url}`));
    if (result.status) console.error(chalk.gray(`  status: ${result.status}`));
    console.error(chalk.gray(`  error: ${result.error}`));
    process.exit(1);
  }
  console.log(chalk.green(`✓ Server reachable: ${profile.serverUrl}`));
  console.log(chalk.gray(`  url: ${result.url}`));
  if (result.version) console.log(chalk.gray(`  version: ${result.version}`));
}

async function cmdSet(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const serverUrlRaw = argvValue(args, '--server-url');
  const webappUrlRaw = argvValue(args, '--webapp-url');
  const serverUrl = normalizeUrlOrThrow(serverUrlRaw, '--server-url');
  const webappUrl = webappUrlRaw
    ? normalizeUrlOrThrow(webappUrlRaw, '--webapp-url')
    : configuration.webappUrl;
  const created = await addServerProfile({ name: 'custom', serverUrl, webappUrl, use: true });
  reloadConfiguration();
  if (json) {
    printJsonEnvelope({ ok: true, kind: 'server_set', data: { active: summarizeProfile(created) } });
    return;
  }
  console.log(chalk.green(`✓ Active server: ${created.name} (${created.id})`));
  console.log(chalk.gray(`  ${created.serverUrl}`));
}
