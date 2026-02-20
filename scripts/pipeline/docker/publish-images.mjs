// @ts-check

import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const MULTIARCH_BUILDER_NAME = 'happier-multiarch';
const MULTIARCH_BUILDER_FALLBACK_NAME = 'happier-multiarch-docker-container';
const DEFAULT_BUILD_RETRIES = 2;

/**
 * @param {number} ms
 */
function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function splitCsvLower(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ dryRun?: boolean; stdio?: 'inherit' | 'pipe'; timeoutMs?: number }} [opts]
 */
function run(cmd, args, opts) {
  const dryRun = opts?.dryRun === true;
  const stdio = opts?.stdio ?? 'inherit';
  const timeoutMs = opts?.timeoutMs ?? 30 * 60_000;
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return '';
  }

  return execFileSync(cmd, args, {
    env: process.env,
    encoding: 'utf8',
    stdio,
    timeout: timeoutMs,
  });
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isTransientDockerBuildError(text) {
  const raw = String(text ?? '');
  return (
    /Cannot connect to the Docker daemon/i.test(raw) ||
    /error reading from server:\s*EOF/i.test(raw) ||
    /rpc error:\s*code\s*=\s*Unavailable/i.test(raw)
  );
}

/**
 * Stream a child process while capturing a tail of stderr for diagnostics.
 *
 * `docker buildx build` writes progress to stderr, so we stream both stdout and stderr to keep local runs readable.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs: number; maxStderrBytes?: number }} opts
 * @returns {Promise<{ exitCode: number; stderrTail: string }>}
 */
function runStreaming(cmd, args, opts) {
  const timeoutMs = opts.timeoutMs;
  const maxStderrBytes = opts.maxStderrBytes ?? 128 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    /** @type {string} */
    let stderrTail = '';
    /** @type {NodeJS.Timeout | undefined} */
    let timer;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.stdout.on('data', (chunk) => {
      try {
        process.stdout.write(chunk);
      } catch {
        // ignore
      }
    });

    child.stderr.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        // ignore
      }
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        stderrTail = (stderrTail + text).slice(-maxStderrBytes);
      } catch {
        // ignore
      }
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: typeof code === 'number' ? code : 1, stderrTail });
    });
  });
}

/**
 * Run `docker buildx build ...` with a small retry budget for transient Docker Desktop / BuildKit failures.
 *
 * This is especially important on macOS where Docker Desktop occasionally restarts the engine during long multi-arch builds.
 *
 * @param {{
 *   dockerArgs: string[];
 *   dryRun: boolean;
 *   retries?: number;
 *   onRetry?: (attempt: number, errorText: string) => void;
 * }} opts
 */
async function runDockerBuildxBuildWithRetry(opts) {
  const retries = Number.isFinite(opts.retries) ? opts.retries : DEFAULT_BUILD_RETRIES;
  const attempts = Math.max(1, retries);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (opts.dryRun) {
      run('docker', opts.dockerArgs, { dryRun: true });
      return;
    }

    const { exitCode, stderrTail } = await runStreaming('docker', opts.dockerArgs, {
      timeoutMs: 60 * 60_000,
    });
    if (exitCode === 0) return;

    const transient = isTransientDockerBuildError(stderrTail);
    if (transient && attempt < attempts) {
      opts.onRetry?.(attempt, stderrTail);
      continue;
    }

    const printable = `docker ${opts.dockerArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
    const hint = transient ? ' (transient error)' : '';
    throw new Error(`[pipeline] docker buildx build failed${hint}: ${printable}`);
  }
}

/**
 * @param {{ dryRun: boolean }} opts
 */
function dockerPreflight(opts) {
  console.log('[pipeline] docker preflight: docker info');
  try {
    run('docker', ['info'], { dryRun: opts.dryRun, stdio: 'pipe', timeoutMs: 10_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!opts.dryRun && process.platform === 'darwin') {
      console.warn('[pipeline] docker preflight: attempting to start Docker Desktop (macOS)');
      try {
        run('open', ['-a', 'Docker'], { dryRun: false, stdio: 'inherit', timeoutMs: 60_000 });
      } catch (openErr) {
        const openMsg = openErr instanceof Error ? openErr.message : String(openErr);
        console.warn(`[pipeline] docker preflight: failed to start Docker Desktop via open: ${openMsg}`);
      }

      const deadlineMs = Date.now() + 60_000;
      while (Date.now() < deadlineMs) {
        try {
          run('docker', ['info'], { dryRun: false, stdio: 'pipe', timeoutMs: 10_000 });
          console.warn('[pipeline] docker preflight: Docker is up');
          return;
        } catch {
          sleepSync(1_000);
        }
      }
    }
    fail(
      [
        '[pipeline] docker preflight failed: Docker daemon is not responding.',
        'Fix: restart Docker Desktop (and if it still fails, use Docker Desktop → Troubleshoot → Clean / Purge data).',
        `Error: ${msg}`,
      ].join('\n'),
    );
  }
}

/**
 * @param {{ dryRun: boolean }} opts
 */
function dockerLogin(opts) {
  const username = String(process.env.DOCKERHUB_USERNAME ?? '').trim();
  const token = String(process.env.DOCKERHUB_TOKEN ?? '').trim();
  if (opts.dryRun) {
    const printable = `docker login docker.io --username ${username || '$DOCKERHUB_USERNAME'} --password-stdin`;
    console.log(`[dry-run] ${printable}`);
    return;
  }

  if (!username) {
    fail('[pipeline] missing DOCKERHUB_USERNAME (required to push Docker images)');
  }
  if (!token) {
    fail('[pipeline] missing DOCKERHUB_TOKEN (required to push Docker images)');
  }

  console.log('[pipeline] docker login: docker.io');
  try {
    execFileSync('docker', ['login', '--username', username, '--password-stdin'], {
      env: process.env,
      input: `${token}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      [
        '[pipeline] docker login failed.',
        'Fix: verify DOCKERHUB_USERNAME/DOCKERHUB_TOKEN (token needs write access to the target repos).',
        `Error: ${msg}`,
      ].join('\n'),
    );
  }
}

/**
 * @returns {boolean}
 */
function isGithubActions() {
  return String(process.env.GITHUB_ACTIONS ?? '')
    .trim()
    .toLowerCase() === 'true';
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function tryGh(args) {
  try {
    const out = execFileSync('gh', args, {
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return String(out ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {{ dryRun: boolean }} opts
 */
function dockerLoginGhcr(opts) {
  const registry = String(process.env.GHCR_REGISTRY ?? 'ghcr.io').trim() || 'ghcr.io';
  const localMode = !isGithubActions();

  let username = String(process.env.GHCR_USERNAME ?? process.env.GITHUB_ACTOR ?? '').trim();
  let token = String(process.env.GHCR_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim();

  if (!opts.dryRun && localMode) {
    if (!token) token = tryGh(['auth', 'token']);
    if (!username) username = tryGh(['api', 'user', '-q', '.login']);
  }

  if (opts.dryRun) {
    const printable = `docker login ${registry} --username ${username || '$GHCR_USERNAME'} --password-stdin`;
    console.log(`[dry-run] ${printable}`);
    return;
  }

  if (!username) {
    fail(
      [
        '[pipeline] missing GHCR_USERNAME (required to push GHCR images).',
        'Fix: set GHCR_USERNAME, or authenticate with GitHub CLI locally via `gh auth login`.',
      ].join('\n'),
    );
  }
  if (!token) {
    fail(
      [
        '[pipeline] missing GHCR_TOKEN (required to push GHCR images).',
        'Fix: set GHCR_TOKEN, or authenticate with GitHub CLI locally via `gh auth login`.',
      ].join('\n'),
    );
  }

  console.log(`[pipeline] docker login: ${registry}`);
  try {
    execFileSync('docker', ['login', registry, '--username', username, '--password-stdin'], {
      env: process.env,
      input: `${token}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      [
        `[pipeline] docker login failed for ${registry}.`,
        'Fix: verify GHCR_USERNAME/GHCR_TOKEN (token needs packages:write on the repo or org).',
        `Error: ${msg}`,
      ].join('\n'),
    );
  }
}

/**
 * @param {unknown} raw
 * @returns {Set<'dockerhub' | 'ghcr'>}
 */
function resolveRegistries(raw) {
  const fromEnv = String(process.env.PIPELINE_DOCKER_REGISTRIES ?? '').trim();
  const v = String(raw ?? '').trim() || fromEnv || 'dockerhub';
  const tokens = splitCsvLower(v);
  if (tokens.length === 0) return new Set(['dockerhub']);

  /** @type {Set<'dockerhub' | 'ghcr'>} */
  const out = new Set();
  for (const t of tokens) {
    if (t === 'dockerhub') {
      out.add('dockerhub');
      continue;
    }
    if (t === 'ghcr') {
      out.add('ghcr');
      continue;
    }
    fail(`Unsupported docker registry token: ${t} (supported: dockerhub,ghcr)`);
  }
  return out;
}

/**
 * @param {string} builderName
 * @param {{ dryRun: boolean }} opts
 * @returns {{ ok: boolean; output: string }}
 */
function tryInspectBuilder(builderName, opts) {
  if (opts.dryRun) {
    console.log(`[dry-run] docker buildx inspect ${builderName}`);
    return { ok: true, output: '' };
  }
  try {
    const out = run('docker', ['buildx', 'inspect', builderName], { dryRun: false, stdio: 'pipe' });
    return { ok: true, output: String(out ?? '') };
  } catch {
    return { ok: false, output: '' };
  }
}

/**
 * @param {string} inspectOutput
 * @returns {string}
 */
function parseBuildxDriver(inspectOutput) {
  const m = String(inspectOutput ?? '').match(/^\s*Driver:\s*([^\s]+)\s*$/m);
  return m ? String(m[1] ?? '').trim() : '';
}

/**
 * Ensures a docker-container buildx builder exists for multi-platform builds.
 *
 * We avoid mutating global Docker config by using `--builder <name>` on each build rather than `buildx use`.
 *
 * @param {{ dryRun: boolean }} opts
 * @returns {string} builder name to use
 */
function ensureMultiarchBuilder(opts) {
  const primary = tryInspectBuilder(MULTIARCH_BUILDER_NAME, opts);
  if (primary.ok) {
    const driver = parseBuildxDriver(primary.output);
    if (!driver || driver === 'docker-container') return MULTIARCH_BUILDER_NAME;
    // If the existing builder name points at the `docker` driver, it can't do multi-platform builds.
    // Create a dedicated docker-container builder under a stable fallback name.
  }

  // If the primary name doesn't exist OR is not docker-container, create a docker-container builder.
  const fallback = MULTIARCH_BUILDER_FALLBACK_NAME;
  const existingFallback = tryInspectBuilder(fallback, opts);
  if (!existingFallback.ok) {
    run(
      'docker',
      ['buildx', 'create', '--name', fallback, '--driver', 'docker-container'],
      { dryRun: opts.dryRun },
    );
  }
  return fallback;
}

/**
 * @param {string} channel
 */
function resolveTagSpec(channel) {
  if (channel === 'stable') {
    return { channelTag: 'stable', floatTag: 'latest', policyEnv: 'production' };
  }
  if (channel === 'preview') {
    return { channelTag: 'preview', floatTag: 'preview', policyEnv: 'preview' };
  }
  fail(`--channel must be 'stable' or 'preview' (got: ${channel})`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      registries: { type: 'string', default: '' },
      'source-ref': { type: 'string', default: '' },
      sha: { type: 'string', default: '' },
      'push-latest': { type: 'string', default: 'true' },
      'build-relay': { type: 'string', default: 'true' },
      'build-dev-box': { type: 'string', default: 'true' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const channel = String(values.channel ?? '').trim();
  if (!channel) fail('--channel is required');

  const registries = resolveRegistries(values.registries);
  const { channelTag, floatTag, policyEnv } = resolveTagSpec(channel);

  const pushLatest = parseBool(values['push-latest'], '--push-latest');
  const buildRelay = parseBool(values['build-relay'], '--build-relay');
  const buildDevBox = parseBool(values['build-dev-box'], '--build-dev-box');
  const dryRun = values['dry-run'] === true;

  const shaRaw = String(values.sha ?? '').trim();
  const sha = shaRaw || run('git', ['rev-parse', 'HEAD'], { dryRun: false, stdio: 'pipe' }).trim();
  const shortSha = sha.slice(0, 12);

  const ghcrNamespaceRaw = String(process.env.GHCR_NAMESPACE ?? 'ghcr.io/happier-dev').trim();
  const ghcrNamespace = ghcrNamespaceRaw.endsWith('/') ? ghcrNamespaceRaw.slice(0, -1) : ghcrNamespaceRaw;

  /** @type {string[]} */
  const relayBases = [];
  /** @type {string[]} */
  const devBases = [];
  if (registries.has('dockerhub')) {
    relayBases.push('happierdev/relay-server');
    devBases.push('happierdev/dev-box');
  }
  if (registries.has('ghcr')) {
    relayBases.push(`${ghcrNamespace}/relay-server`);
    devBases.push(`${ghcrNamespace}/dev-box`);
  }

  dockerPreflight({ dryRun });
  if (registries.has('dockerhub')) dockerLogin({ dryRun });
  if (registries.has('ghcr')) dockerLoginGhcr({ dryRun });

  const builder = ensureMultiarchBuilder({ dryRun });

  /** @type {string[]} */
  const relayTags = relayBases.flatMap((base) => [`${base}:${channelTag}`, `${base}:${channelTag}-${shortSha}`]);
  /** @type {string[]} */
  const devTags = devBases.flatMap((base) => [`${base}:${channelTag}`, `${base}:${channelTag}-${shortSha}`]);
  if (pushLatest) {
    for (const base of relayBases) relayTags.push(`${base}:${floatTag}`);
    for (const base of devBases) devTags.push(`${base}:${floatTag}`);
  }

  const useGhaCache = String(process.env.GITHUB_ACTIONS ?? '').toLowerCase() === 'true';

  if (buildRelay) {
    const args = [
      'buildx',
      'build',
      '--file',
      'Dockerfile',
      '--target',
      'relay-server',
      '--builder',
      builder,
      '--platform',
      'linux/amd64,linux/arm64',
      '--push',
      ...(useGhaCache ? ['--cache-from', 'type=gha,scope=relay-server'] : []),
      ...(useGhaCache ? ['--cache-to', 'type=gha,mode=max,scope=relay-server'] : []),
      '--build-arg',
      `HAPPIER_EMBEDDED_POLICY_ENV=${policyEnv}`,
      '--label',
      `org.opencontainers.image.revision=${sha}`,
      ...relayTags.flatMap((t) => ['--tag', t]),
      '.',
    ];
    await runDockerBuildxBuildWithRetry({
      dockerArgs: args,
      dryRun,
      onRetry: (attempt, errorText) => {
        console.warn(`[pipeline] docker buildx build failed (attempt ${attempt}/${DEFAULT_BUILD_RETRIES}), retrying...`);
        if (errorText) {
          const firstLine = String(errorText).split('\n').find(Boolean);
          if (firstLine) console.warn(`[pipeline] transient error: ${firstLine}`);
        }
        dockerPreflight({ dryRun: false });
      },
    });
  }

  if (buildDevBox) {
    const args = [
      'buildx',
      'build',
      '--file',
      'docker/dev-box/Dockerfile',
      '--builder',
      builder,
      '--platform',
      'linux/amd64,linux/arm64',
      '--push',
      ...(useGhaCache ? ['--cache-from', 'type=gha,scope=dev-box'] : []),
      ...(useGhaCache ? ['--cache-to', 'type=gha,mode=max,scope=dev-box'] : []),
      '--label',
      `org.opencontainers.image.revision=${sha}`,
      ...devTags.flatMap((t) => ['--tag', t]),
      '.',
    ];
    await runDockerBuildxBuildWithRetry({
      dockerArgs: args,
      dryRun,
      onRetry: (attempt, errorText) => {
        console.warn(`[pipeline] docker buildx build failed (attempt ${attempt}/${DEFAULT_BUILD_RETRIES}), retrying...`);
        if (errorText) {
          const firstLine = String(errorText).split('\n').find(Boolean);
          if (firstLine) console.warn(`[pipeline] transient error: ${firstLine}`);
        }
        dockerPreflight({ dryRun: false });
      },
    });
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
});
