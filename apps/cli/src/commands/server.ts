import chalk from 'chalk';
import { configuration, reloadConfiguration } from '@/configuration';
import { createInterface } from 'node:readline';
import {
  addServerProfile,
  getActiveServerProfile,
  getServerProfile,
  listServerProfiles,
  removeServerProfile,
  useServerProfile,
} from '@/server/serverProfiles';
import { probeServerVersion } from '@/server/serverTest';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

export async function handleServerCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showServerHelp();
    return;
  }

  switch (subcommand) {
    case 'list':
      await cmdList();
      return;
    case 'current':
      await cmdCurrent();
      return;
    case 'add':
      await cmdAdd(args.slice(1));
      return;
    case 'use':
      await cmdUse(args.slice(1));
      return;
    case 'remove':
      await cmdRemove(args.slice(1));
      return;
    case 'test':
      await cmdTest(args.slice(1));
      return;
    case 'set':
      await cmdSet(args.slice(1));
      return;
    default:
      console.error(chalk.red(`Unknown server subcommand: ${subcommand}`));
      showServerHelp();
      process.exit(1);
  }
}

function showServerHelp(): void {
  console.log(`
${chalk.bold('happier server')} - Manage Happier server profiles

${chalk.bold('Usage:')}
  happier server list
  happier server current
  happier server add [--name <name>] [--server-url <url>] [--webapp-url <url>] [--use] [--no-use] [--start-daemon] [--install-service]
  happier server use <name-or-id>
  happier server remove <name-or-id> [--force]
  happier server test [<name-or-id>]
  happier server set --server-url <url> [--webapp-url <url>]

${chalk.bold('Notes:')}
  • Profiles are stored in ${configuration.settingsFile}
  • Credentials are stored per-server under ${configuration.serversDir}
  • Env vars override for one run: HAPPIER_SERVER_URL / HAPPIER_WEBAPP_URL
`);
}

function argvValue(args: ReadonlyArray<string>, name: string): string {
  const n = String(name ?? '').trim();
  if (!n) return '';
  const idx = args.findIndex((a) => a === n);
  if (idx !== -1) {
    const v = String(args[idx + 1] ?? '');
    return v && !v.startsWith('--') ? v : '';
  }
  const withEq = args.find((a) => a.startsWith(`${n}=`));
  if (withEq) return withEq.slice(`${n}=`.length);
  return '';
}

function normalizeUrlOrThrow(raw: string, label: string): string {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`Missing ${label}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid ${label} protocol: ${url.protocol} (expected http/https)`);
  }
  return url.toString().replace(/\/+$/, '');
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function defaultNameFromUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return 'custom';
  }
}

function defaultWebappUrlFromServerUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin.replace(/\/+$/, '');
  } catch {
    return configuration.webappUrl;
  }
}

function parseYesNoWithDefault(raw: string, defaultValue: boolean): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === 'y' || value === 'yes') return true;
  if (value === 'n' || value === 'no') return false;
  return defaultValue;
}

async function promptInput(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
    });
  } finally {
    rl.close();
  }
}

async function runCliAction(args: string[]): Promise<void> {
  const child = spawnHappyCLI(args, {
    stdio: 'inherit',
    env: process.env,
  });

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit ${code ?? 1}): happier ${args.join(' ')}`));
    });
  });
}

async function cmdList(): Promise<void> {
  const active = await getActiveServerProfile();
  const profiles = await listServerProfiles();
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

async function cmdCurrent(): Promise<void> {
  const active = await getActiveServerProfile();
  console.log(chalk.bold('Active server'));
  console.log(`${chalk.gray('name:')}   ${active.name}`);
  console.log(`${chalk.gray('id:')}     ${active.id}`);
  console.log(`${chalk.gray('server:')} ${active.serverUrl}`);
  console.log(`${chalk.gray('webapp:')} ${active.webappUrl}`);
}

async function cmdAdd(args: string[]): Promise<void> {
  const interactive = isInteractiveTerminal();
  let name = argvValue(args, '--name');
  let serverUrlRaw = argvValue(args, '--server-url');
  let webappUrlRaw = argvValue(args, '--webapp-url');
  const hasUse = args.includes('--use');
  const hasNoUse = args.includes('--no-use');
  let shouldUse = hasUse;
  let startDaemon = args.includes('--start-daemon');
  let installService = args.includes('--install-service');

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
    if (!webappUrlRaw) {
      const defaultWebappUrl = defaultWebappUrlFromServerUrl(serverUrlForDefaults);
      const answer = await promptInput(`Web app URL [${defaultWebappUrl}]: `);
      webappUrlRaw = answer.trim() || defaultWebappUrl;
    }
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
    if (!startDaemon && !installService) {
      const answer = await promptInput('Start daemon now for this server? [y/N]: ');
      startDaemon = parseYesNoWithDefault(answer, false);
      if (startDaemon) {
        const serviceAnswer = await promptInput('Install daemon as background service too? [y/N]: ');
        installService = parseYesNoWithDefault(serviceAnswer, false);
      }
    }
  }

  if (!name) throw new Error('Missing --name');
  const serverUrl = normalizeUrlOrThrow(serverUrlRaw, '--server-url');
  const webappUrl = webappUrlRaw
    ? normalizeUrlOrThrow(webappUrlRaw, '--webapp-url')
    : defaultWebappUrlFromServerUrl(serverUrl);

  const created = await addServerProfile({ name, serverUrl, webappUrl, use: shouldUse });
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
  const identifier = String(args[0] ?? '').trim();
  if (!identifier) throw new Error('Missing server id/name');
  const active = await useServerProfile(identifier);
  reloadConfiguration();
  console.log(chalk.green(`✓ Active server: ${active.name} (${active.id})`));
  console.log(chalk.gray(`  ${active.serverUrl}`));
}

async function cmdRemove(args: string[]): Promise<void> {
  const identifier = String(args[0] ?? '').trim();
  if (!identifier) throw new Error('Missing server id/name');
  const force = args.includes('--force');
  const out = await removeServerProfile(identifier, { force });
  reloadConfiguration();
  console.log(chalk.green(`✓ Removed server profile: ${out.removed.name} (${out.removed.id})`));
  console.log(chalk.gray(`  Active server: ${out.active.name} (${out.active.id})`));
}

async function cmdTest(args: string[]): Promise<void> {
  const identifier = String(args[0] ?? '').trim();
  const profile = identifier ? await getServerProfile(identifier) : await getActiveServerProfile();
  const result = await probeServerVersion(profile.serverUrl);
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
  const serverUrlRaw = argvValue(args, '--server-url');
  const webappUrlRaw = argvValue(args, '--webapp-url');
  const serverUrl = normalizeUrlOrThrow(serverUrlRaw, '--server-url');
  const webappUrl = webappUrlRaw ? normalizeUrlOrThrow(webappUrlRaw, '--webapp-url') : configuration.webappUrl;
  const created = await addServerProfile({ name: 'custom', serverUrl, webappUrl, use: true });
  reloadConfiguration();
  console.log(chalk.green(`✓ Active server: ${created.name} (${created.id})`));
  console.log(chalk.gray(`  ${created.serverUrl}`));
}
