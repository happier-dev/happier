import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { buildTerminalBenchmarkReport, summarizeTerminalSample } from './report';
import { getTerminalWorkload, listTerminalWorkloads, type TerminalWorkloadId } from './workloads';

type Options = Readonly<{ out: string; repeat: number; workloads: readonly TerminalWorkloadId[] }>;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');

function parseArgs(args: readonly string[]): Options {
  let out = '';
  let repeat = 3;
  const workloads: TerminalWorkloadId[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out') out = args[++index] ?? '';
    else if (arg === '--repeat') repeat = Number.parseInt(args[++index] ?? '', 10);
    else if (arg === '--workload') workloads.push(args[++index] as TerminalWorkloadId);
    else throw new Error(`Unknown renderer benchmark argument: ${arg}`);
  }
  if (!out) throw new Error('--out is required');
  if (!Number.isInteger(repeat) || repeat < 3) throw new Error('--repeat must be at least 3');
  const known = new Set(listTerminalWorkloads().map((workload) => workload.id));
  if (workloads.some((id) => !known.has(id))) throw new Error('unknown --workload value');
  return { out, repeat, workloads: workloads.length ? workloads : [...known] };
}

export async function runXtermWebRendererBenchmark(options: Options) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.setContent('<div id="terminal" style="width:1000px;height:720px"></div>');
    await page.addStyleTag({ path: resolve(REPO_ROOT, 'node_modules/@xterm/xterm/css/xterm.css') });
    await page.addScriptTag({ path: resolve(REPO_ROOT, 'node_modules/@xterm/xterm/lib/xterm.js') });
    await page.evaluate(() => {
      const TerminalCtor = (globalThis as unknown as { Terminal: new (options: object) => {
        open(element: HTMLElement): void;
        write(data: Uint8Array, callback: () => void): void;
        clear(): void;
      } }).Terminal;
      const terminal = new TerminalCtor({ cols: 120, rows: 40, scrollback: 5000, screenReaderMode: true });
      terminal.open(document.getElementById('terminal')!);
      (globalThis as unknown as { __happierTerminal: typeof terminal }).__happierTerminal = terminal;
    });

    const startedAt = new Date().toISOString();
    const samples = [];
    for (let run = 0; run < options.repeat; run += 1) {
      for (const workloadId of options.workloads) {
        const workload = getTerminalWorkload(workloadId);
        const result = await page.evaluate(async (base64) => {
          const binary = atob(base64);
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          const terminal = (globalThis as unknown as { __happierTerminal: {
            write(data: Uint8Array, callback: () => void): void;
            clear(): void;
          } }).__happierTerminal;
          terminal.clear();
          const started = performance.now();
          const parserMs = await new Promise<number>((resolveWrite) => {
            terminal.write(bytes, () => resolveWrite(performance.now() - started));
          });
          await new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
          return { parserMs, displayMs: performance.now() - started };
        }, Buffer.from(workload.bytes).toString('base64'));
        const environment = { platform: 'chromium', targetId: 'playwright-headless' };
        samples.push(summarizeTerminalSample({
          renderer: 'xterm-web', workloadId, decodedBytes: workload.byteLength,
          durationMs: Math.max(1, Math.ceil(result.parserMs)), ackLatenciesMs: [result.parserMs],
          timingBoundary: 'parser-write-complete', observationSource: 'automated-browser', environment,
        }));
        samples.push(summarizeTerminalSample({
          renderer: 'xterm-web', workloadId, decodedBytes: workload.byteLength,
          durationMs: Math.max(1, Math.ceil(result.displayMs)), ackLatenciesMs: [result.parserMs],
          timingBoundary: 'display-observed', observationSource: 'automated-browser', environment,
        }));
      }
    }
    return buildTerminalBenchmarkReport({
      measurementScope: 'renderer',
      suite: 'terminal-xterm-web-playwright',
      startedAt,
      endedAt: new Date().toISOString(),
      samples,
    });
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith('rendererBenchCli.ts')) {
  const options = parseArgs(process.argv.slice(2));
  const report = await runXtermWebRendererBenchmark(options);
  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`terminal renderer benchmark: ${out}`);
}
