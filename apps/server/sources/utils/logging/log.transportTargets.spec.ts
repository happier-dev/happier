import pino from 'pino';
import { logger as structuredErrorLogger } from './log';
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
  it('initializes logging from the effective post-overlay startup environment', async () => {
    setBunRuntime(true);
    const mod = await import('./log');
    mod.initializeServerLogging({ HAPPIER_SERVER_LOG_LEVEL: 'warn' });
    expect(mod.logger.level).toBe('warn');
  });
  it('defaults a production Node server (the Docker images) to JSON stdout with no transport worker', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    expect(mod.createLoggingTransportTargets({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('keeps pretty output by default for development Node servers (source and stack runs)', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    expect(mod.createLoggingTransportTargets({}).map(t => t.target)).toEqual(['pino-pretty']);
    expect(mod.createLoggingTransportTargets({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).map(t => t.target)).toEqual(['pino-pretty']);
  });

  it('runs every server image with the production log default', async () => {
    const mod = await import('./log');
    const dockerfile = readFileSync(new URL('../../../../../Dockerfile', import.meta.url), 'utf8');
    // ENV lines of one stage, following its FROM parents inside this Dockerfile.
    const stageEnv = (stage: string): NodeJS.ProcessEnv => {
      const blocks = dockerfile.split(/^FROM /m).slice(1);
      const block = blocks.find(text => new RegExp(`\\bAS ${stage}\\s*$`, 'm').test(text.split('\n')[0]!));
      if (!block) throw new Error(`missing stage ${stage}`);
      const parent = block.split('\n')[0]!.trim().split(/\s+/).filter(word => !word.startsWith('--'))[0]!;
      const inherited = blocks.some(text => new RegExp(`\\bAS ${parent}\\s*$`, 'm').test(text.split('\n')[0]!)) ? stageEnv(parent) : {};
      const own = Object.fromEntries([...block.matchAll(/^ENV (\w+)=(\S*)/gm)].map(match => [match[1]!, match[2]!]));
      return { ...inherited, ...own };
    };
    for (const stage of ['server', 'server-worker', 'relay-server']) expect([stage, mod.resolveServerLogFormat(stageEnv(stage))]).toEqual([stage, 'json']);
  });

  it('includes pino-pretty transport when pretty is selected on a production Node server', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({ NODE_ENV: 'production', HAPPIER_SERVER_LOG_FORMAT: 'pretty' } as NodeJS.ProcessEnv);
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

  it('uses the runtime default for unrecognized log formats', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    expect(mod.resolveServerLogFormat({ HAPPIER_SERVER_LOG_FORMAT: 'yaml', NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('json');
    expect(mod.resolveServerLogFormat({ HAPPIER_SERVER_LOG_FORMAT: 'yaml' } as NodeJS.ProcessEnv)).toBe('pretty');
  });

  it('selects the log format from the effective Home startup configuration', async () => {
    setBunRuntime(false);
    const { buildStartupHomeEnv } = await import('@/app/home/settings/startupHomeEnv');
    const { SERVER_CONFIG_REGISTRY } = await import('@/config/serverConfigRegistry');
    const mod = await import('./log');
    const stored = { values: { HAPPIER_SERVER_LOG_FORMAT: 'pretty' }, secrets: {} };
    // The production default does not lock the Home setting: a stored choice still applies.
    const startup = buildStartupHomeEnv({ env: { NODE_ENV: 'production' }, stored, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) });
    expect(mod.createLoggingTransportTargets(startup.env).some(t => t.target === 'pino-pretty')).toBe(true);
    const locked = buildStartupHomeEnv({ env: { HAPPIER_SERVER_LOG_FORMAT: 'json' }, stored, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) });
    expect(mod.createLoggingTransportTargets(locked.env)).toEqual([]);
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
});

describe('structured errors', () => {
  it('retains a closed Run release reason in the existing completion projection without payloads', () => {
    const output: string[] = [];
    const logger = structuredErrorLogger;
    const previousLevel = logger.level;
    logger.level = 'info';
    const stream = Reflect.get(logger, pino.symbols.streamSym);
    Reflect.set(logger, pino.symbols.streamSym, { write: (chunk: string) => output.push(chunk) });
    try {
      logger.info({ res: { statusCode: 409, request: { authTokenKind: 'terminal', userId: 'fixture-account',
        headers: { authorization: 'PRIVATE_SENTINEL' }, body: { private: 'PRIVATE_SENTINEL' },
        followSourceRoute: { resultCode: 'source_unavailable', sourceKind: 'execution_run',
          sourceSessionId: 'parent', sourceRunId: 'run', releaseReason: 'target_machine', payload: 'PRIVATE_SENTINEL' },
      } } }, 'request completed');
      const record = JSON.parse(output.join(''));
      expect(record.res.followSourceRoute).toEqual({ resultCode: 'source_unavailable', sourceKind: 'execution_run',
        sourceSessionId: 'parent', sourceRunId: 'run', releaseReason: 'target_machine' });
      expect(output.join('')).not.toContain('PRIVATE_SENTINEL');
    } finally { Reflect.set(logger, pino.symbols.streamSym, stream); logger.level = previousLevel; }
  });
  it.each(['connected-accounts:daemon-coordinator', 'connected-accounts:requester-coordinator', 'connected-accounts:qualification',
    'connected-accounts:purpose-binding', 'connected-accounts:startup-hydration', 'connected-accounts:quota-qualification',
    'connected-accounts:usage-persistence', 'connected-accounts:request-auth-replacement', 'connected-accounts:auth-group',
    'connected-accounts:spawn', 'connected-accounts:persistence'])(
    'retains the bounded connected-account purpose %s without request or credential data', purpose => {
      const output: string[] = [];
      const logger = structuredErrorLogger;
      const previousLevel = logger.level;
      logger.level = 'info';
      const stream = Reflect.get(logger, pino.symbols.streamSym);
      Reflect.set(logger, pino.symbols.streamSym, { write: (chunk: string) => output.push(chunk) });
      try {
        logger.info({ res: { statusCode: 200, request: { authTokenKind: 'terminal', authAuthority: 'present_user',
          userId: 'fixture-account', headers: { 'x-happier-request-purpose': purpose, authorization: 'PRIVATE_SENTINEL' },
          body: { private: 'PRIVATE_SENTINEL' } } } }, 'request completed');
        const record = JSON.parse(output.join(''));
        expect(record.res).toMatchObject({ statusCode: 200, requestPurpose: purpose, authTokenKind: 'terminal' });
        expect(output.join('')).not.toContain('PRIVATE_SENTINEL');
        expect(record.res).not.toHaveProperty('request');
      } finally { Reflect.set(logger, pino.symbols.streamSym, stream); logger.level = previousLevel; }
    },
  );

  it.each([{ purpose: 'PRIVATE_SENTINEL' }, { purpose: ['connected-accounts:qualification', 'PRIVATE_SENTINEL'] }])(
    'rejects unrecognized or malformed purpose headers without logging their contents', ({ purpose }) => {
      const output: string[] = [];
      const logger = structuredErrorLogger;
      const previousLevel = logger.level;
      logger.level = 'info';
      const stream = Reflect.get(logger, pino.symbols.streamSym);
      Reflect.set(logger, pino.symbols.streamSym, { write: (chunk: string) => output.push(chunk) });
      try {
        logger.info({ res: { statusCode: 200, request: { headers: { 'x-happier-request-purpose': purpose } } } }, 'request completed');
        expect(JSON.parse(output.join('')).res.requestPurpose).toBe('unrecognized');
        expect(output.join('')).not.toContain('PRIVATE_SENTINEL');
      } finally { Reflect.set(logger, pino.symbols.streamSym, stream); logger.level = previousLevel; }
    },
  );

  it('preserves non-enumerable error details under the existing error field', async () => {
    setBunRuntime(true);
    const logger = structuredErrorLogger;
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


describe('idle log output', () => {
  // Counts log transport worker threads and their event-loop wakes over an idle window
  // after real startup logging. A pino transport worker polls its ring buffer (~1/s).
  async function countIdleLogWorkerWakes(env: NodeJS.ProcessEnv) {
    const result = await promisify(execFile)(process.execPath, [
      '--conditions=happier-source', '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--eval',
      `(async () => {
       const { createRequire } = await import('node:module');
       const threads = createRequire(${JSON.stringify(import.meta.url)})('node:worker_threads');
       // A thread the process owns besides the logger (a runner or loader worker): never a log worker.
       const unrelated = new threads.Worker('setInterval(() => {}, 200)', { eval: true });
       const mod = await import(${JSON.stringify(new URL('./log.ts', import.meta.url).href)});
       mod.initializeServerLogging(process.env);
       mod.logger.info('startup line');
       // The logger's own transport: pino's destination stream is a thread-stream that owns its worker.
       const destination = mod.logger[createRequire(${JSON.stringify(import.meta.url)})('pino').symbols.streamSym];
       const workers = destination && destination.worker ? [destination.worker] : [];
       await new Promise(resolve => setTimeout(resolve, 500));
       const before = workers.map(w => w.performance.eventLoopUtilization());
       await new Promise(resolve => setTimeout(resolve, 2500));
       const activeMs = workers.reduce((sum, w, i) => sum + w.performance.eventLoopUtilization(before[i]).active, 0);
       unrelated.terminate();
       process.stderr.write('IDLE ' + JSON.stringify({ workers: workers.length, activeMs }) + '\\n');
       process.exit(0);
      })();`,
    ], { encoding: 'utf8', env: { ...process.env, DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '', HAPPIER_SERVER_LOG_LEVEL: 'info', ...env } });
    const line = result.stderr.split('\n').find(entry => entry.startsWith('IDLE '));
    return JSON.parse(line!.slice('IDLE '.length)) as { workers: number; activeMs: number };
  }

  it('starts no log worker by default in production, so an idle Docker server is never woken by logging', async () => {
    // An empty value is unset for the server config codec.
    const production = await countIdleLogWorkerWakes({ HAPPIER_SERVER_LOG_FORMAT: '', NODE_ENV: 'production' });
    expect(production).toEqual({ workers: 0, activeMs: 0 });
    const development = await countIdleLogWorkerWakes({ HAPPIER_SERVER_LOG_FORMAT: '', NODE_ENV: '' });
    console.info(`idle-log-worker production=${JSON.stringify(production)} development=${JSON.stringify(development)}`);
    expect(development.workers).toBe(1);
  }, 30_000);
});

describe('pretty stdout', () => {
  it('writes one line per request event while retaining warning, slow and failed request diagnostics', async () => {
    const requestCount = 10;
    const result = await promisify(execFile)(process.execPath, [
      '--conditions=happier-source', '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--eval',
      `(async () => { const mod = await import(${JSON.stringify(new URL('./log.ts', import.meta.url).href)});
       const { default: Fastify } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('fastify')).href)});
       mod.initializeServerLogging(process.env);
       const { logger } = mod;
       const app = Fastify({ loggerInstance: logger });
       app.get('/logging-check', async () => ({ ok: true }));
       app.get('/logging-failure', async (_request, reply) => reply.code(503).send());
       for (let i = 0; i < ${requestCount}; i++) await app.inject({ method: 'GET', url: '/logging-check' });
       logger.warn({ diagnostic: { phase: 'warning', detail: 'warning context retained' } }, 'warning detail retained');
       await app.inject({ method: 'GET', url: '/logging-failure' });
       await app.close();
       logger.info({ res: { statusCode: 200 }, responseTime: 12345 }, 'slow request retained');
       logger.error({ error: new Error('failure detail retained') }, 'failed request retained');
      })();`,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HAPPIER_SERVER_LOG_FORMAT: 'pretty', HAPPIER_SERVER_LOG_LEVEL: 'info',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '' },
    });
    const lines = result.stdout.trim().split('\n').filter(line => line.trim());
    const requestLines = lines.slice(0, lines.findIndex(line => line.includes('warning detail retained')));
    expect(requestLines.length).toBe(requestCount * 2);
    expect(requestLines.filter(line => line.includes('incoming request')).length).toBe(requestCount);
    expect(requestLines.filter(line => line.includes('request completed')).length).toBe(requestCount);
    expect(requestLines.filter(line => line.includes('/logging-check')).length).toBe(requestCount);
    expect(requestLines.filter(line => /statusCode[" ]*:\s*200/.test(line)).length).toBe(requestCount);
    expect(result.stdout).toContain('warning context retained');
    expect(result.stdout).toContain('slow request retained');
    expect(result.stdout).toMatch(/responseTime[" ]*:\s*12345/);
    expect(result.stdout).toContain('failed request retained');
    expect(result.stdout).toContain('/logging-failure');
    expect(result.stdout).toMatch(/statusCode[" ]*:\s*503/);
    expect(result.stdout).toContain('failure detail retained');
    expect(result.stdout).toMatch(/\n\s+at /);
    console.info(`pretty-request-cost requests=${requestCount} lines=${requestLines.length} bytes=${Buffer.byteLength(requestLines.join('\n'))}`);
  });
});

describe('JSON stdout', () => {
  it.each([false, true])('keeps structured stdout and optional debug file output (debug=%s)', async (debug) => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-json-log-'));
    try {
      const result = await promisify(execFile)(process.execPath, [
        '--conditions=happier-source', '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--eval',
        `(async () => { const mod = await import(${JSON.stringify(new URL('./log.ts', import.meta.url).href)});
         mod.initializeServerLogging(process.env);
         const { logger, fileConsolidatedLogger } = mod;
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
