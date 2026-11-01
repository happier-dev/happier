import pino from 'pino';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function setBunRuntime(enabled: boolean) {
  const g = globalThis as any;
  if (enabled) {
    g.Bun = {};
  } else {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete g.Bun;
  }
}

afterEach(() => {
  setBunRuntime(false);
  vi.resetModules();
});

describe('createLoggingTransportTargets', () => {
  it('includes pino-pretty transport when not running under Bun', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({});
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(true);
  });

  it('does not include pino-pretty transport when running under Bun', async () => {
    setBunRuntime(true);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({});
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(false);
  });

  it('omits the pino-pretty transport when the json log format is selected', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({ HAPPIER_SERVER_LOG_FORMAT: ' JSON ' } as NodeJS.ProcessEnv);
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(false);
  });

  it('keeps the pino-pretty transport for unrecognized log formats', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({ HAPPIER_SERVER_LOG_FORMAT: 'yaml' } as NodeJS.ProcessEnv);
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(true);
  });

  it('defaults the server log level to info', async () => {
    const mod = await import('./log');

    expect(mod.resolveServerLogLevelFromEnv({} as NodeJS.ProcessEnv)).toBe('info');
  });

  it('honors explicit server log level env overrides', async () => {
    const mod = await import('./log');

    expect(mod.resolveServerLogLevelFromEnv({ HAPPIER_SERVER_LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv)).toBe('debug');
    expect(mod.resolveServerLogLevelFromEnv({ LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv)).toBe('warn');
  });

  it('falls back to info for invalid server log levels', async () => {
    const mod = await import('./log');

    expect(mod.resolveServerLogLevelFromEnv({ HAPPIER_SERVER_LOG_LEVEL: 'verbose' } as NodeJS.ProcessEnv)).toBe('info');
  });
});


describe('JSON stdout', () => {
  it.each([false, true])('keeps structured stdout and optional debug file output (debug=%s)', async (debug) => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-json-log-'));
    try {
      const result = await promisify(execFile)(process.execPath, [
        '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--eval',
        `(async () => { const { logger, fileConsolidatedLogger } = await import(${JSON.stringify(new URL('./log.ts', import.meta.url).href)});
         logger.debug({ route: '/v1/ping' }, 'hello json');
         logger.info({ route: '/v1/ping' }, 'file and stdout');
         fileConsolidatedLogger?.info({ source: 'remote-client' }, 'file only'); })();`,
      ], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          HAPPIER_SERVER_LOG_FORMAT: 'json',
          HAPPIER_SERVER_LOG_LEVEL: 'debug',
          DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: debug ? '1' : '',
        },
      });
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ level: 20, route: '/v1/ping', msg: 'hello json' });
      if (debug) {
        const files = readdirSync(join(cwd, '.logs'));
        expect(files).toHaveLength(1);
        const fileRecords = readFileSync(join(cwd, '.logs', files[0]), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        expect(fileRecords).toContainEqual(expect.objectContaining({ level: 20, msg: 'hello json' }));
        expect(fileRecords).toContainEqual(expect.objectContaining({ msg: 'file and stdout' }));
        expect(fileRecords).toContainEqual(expect.objectContaining({ source: 'remote-client', msg: 'file only' }));
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});


describe('structured errors', () => {
  it('preserves non-enumerable error details under the existing error field', async () => {
    setBunRuntime(true);
    const { logger } = await import('./log');
    const output: string[] = [];
    // Replace only Pino's output stream; its real formatter and serializers still run.
    const stream = Reflect.get(logger, pino.symbols.streamSym);
    Reflect.set(logger, pino.symbols.streamSym, { write: (chunk: string) => output.push(chunk) });
    try {
      const error = Object.assign(new Error('unsupported Unicode escape sequence'), {
        name: 'PrismaClientUnknownRequestError', clientVersion: '6.19.2',
      });
      logger.error({ module: 'session-write', error }, 'Message write failed');
      const record = JSON.parse(output.join(''));
      expect(record.error).toMatchObject({
        message: error.message, stack: error.stack, clientVersion: '6.19.2',
      });
    } finally {
      Reflect.set(logger, pino.symbols.streamSym, stream);
    }
  });
});
