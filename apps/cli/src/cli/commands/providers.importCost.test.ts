import { Session } from 'node:inspector';
import { expect, it } from 'vitest';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const forbiddenModules = [
  new URL('./providers/deps.ts', import.meta.url).href,
  new URL('../../providers/connections/runtimeServices.ts', import.meta.url).href,
];

// Like ordinary static owner imports, cold source preparation belongs to module
// collection. The assertion measures evaluated modules, never import duration.
const { providers, scripts } = await importProvidersWithTrace();

async function importProvidersWithTrace() {
  // The CLI unit harness isolates this file in a fresh process. Observe the
  // real owner import without replacing internals or invoking the tsx loader.
  const session = new Session();
  const scripts: string[] = [];
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => scripts.push(params.url.split('?')[0]));
  try {
    await new Promise<void>((resolve, reject) => {
      session.post('Debugger.enable', (error) => error ? reject(error) : resolve());
    });
    scripts.length = 0;
    const providers = await import('./providers');
    return { providers, scripts };
  } finally {
    session.disconnect();
  }
}

it('renders provider help without loading authenticated operation dependencies', async () => {
  const output = captureConsoleText();
  try {
    await providers.handleProvidersCliCommand({
      args: ['provider', '--help', '--json'],
      rawArgv: ['happier', 'provider', '--help', '--json'],
      terminalRuntime: null,
    });
    expect(scripts).toContain(new URL('./providers.ts', import.meta.url).href);
    expect(scripts.filter((url) => forbiddenModules.includes(url))).toEqual([]);
    // The whole captured console/stdout must parse: help prose beside the envelope would break `--json` callers.
    expect(JSON.parse(output.text().trim())).toMatchObject({
      v: 1, ok: true, kind: 'providers_help', data: { help: expect.stringContaining('happier providers list') },
    });
    expect(process.exitCode ?? 0).toBe(0);
  } finally {
    output.restore();
  }
});
