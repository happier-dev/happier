import { configuration } from '@/configuration';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';

export { isInteractiveTerminal, promptInput };

export function argvValue(args: ReadonlyArray<string>, name: string): string {
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

export function normalizeUrlOrThrow(raw: string, label: string): string {
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

export function defaultNameFromUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return 'custom';
  }
}

export function defaultWebappUrlFromServerUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin.replace(/\/+$/, '');
  } catch {
    return configuration.webappUrl;
  }
}

export function parseYesNoWithDefault(raw: string, defaultValue: boolean): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === 'y' || value === 'yes') return true;
  if (value === 'n' || value === 'no') return false;
  return defaultValue;
}

export async function runCliAction(args: string[]): Promise<void> {
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
