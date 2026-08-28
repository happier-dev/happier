import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { terminateProcessGroup } from './terminate.mjs';
import { resolveCommandInvocation } from '../process/resolveCommandInvocation.mjs';
import {
  createBoundedLogWriteStream,
  DEFAULT_BOUNDED_LOG_MAX_BYTES,
} from './boundedLog.mjs';

const plannedExitMarker = Symbol('happier.stack.plannedExit');
const DEFAULT_TEE_MAX_BYTES = DEFAULT_BOUNDED_LOG_MAX_BYTES;

function resolveProcSpawnInvocation(cmd, args, env, shellOverride) {
  if (shellOverride === true) {
    return {
      command: cmd,
      args,
      spawnOptions: { shell: true },
    };
  }
  const invocation = resolveCommandInvocation({ command: cmd, args, env });
  return {
    command: invocation.command,
    args: invocation.args,
    spawnOptions: {
      shell: false,
      ...(invocation.windowsVerbatimArguments !== undefined
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    },
  };
}

function normalizePlannedExitReason(reason) {
  const cleaned = String(reason ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'planned';
}

export function markSpawnedProcessPlannedExit(child, reason = 'planned') {
  if (!child || (typeof child !== 'object' && typeof child !== 'function')) {
    return () => {};
  }

  const marker = { reason: normalizePlannedExitReason(reason) };
  try {
    Object.defineProperty(child, plannedExitMarker, {
      value: marker,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    try {
      child[plannedExitMarker] = marker;
    } catch {
      return () => {};
    }
  }

  return () => {
    try {
      if (child[plannedExitMarker] === marker) {
        delete child[plannedExitMarker];
      }
    } catch {
      // ignore cleanup failures; the marker only affects best-effort log wording
    }
  };
}

export function getSpawnedProcessPlannedExitReason(child) {
  const reason = child?.[plannedExitMarker]?.reason;
  return typeof reason === 'string' && reason ? reason : null;
}

function formatSpawnedProcessExitLine(prefix, code, sig, child) {
  const plannedReason = getSpawnedProcessPlannedExitReason(child);
  const trimmedPrefix = String(prefix ?? '').trimEnd();
  if (plannedReason) {
    return `${trimmedPrefix} planned ${plannedReason} exit (code=${code}, sig=${sig})\n`;
  }
  return `${trimmedPrefix} exited (code=${code}, sig=${sig})\n`;
}

function nextLineBreakIndex(s) {
  const n = s.indexOf('\n');
  const r = s.indexOf('\r');
  if (n < 0) return r;
  if (r < 0) return n;
  return Math.min(n, r);
}

function consumeLineBreak(buf) {
  if (buf.startsWith('\r\n')) return buf.slice(2);
  if (buf.startsWith('\n') || buf.startsWith('\r')) return buf.slice(1);
  return buf;
}

function consumeLineChunk(bufState, chunk) {
  const s = chunk.toString();
  bufState.buf += s;
  const lines = [];
  while (true) {
    const idx = nextLineBreakIndex(bufState.buf);
    if (idx < 0) break;
    const line = bufState.buf.slice(0, idx);
    bufState.buf = consumeLineBreak(bufState.buf.slice(idx));
    lines.push(line);
  }
  return lines;
}

function writePrefixedLines(stream, prefix, lines) {
  for (const line of lines) {
    stream.write(`${prefix}${line}\n`);
  }
}

function writePersistedLogLines(stream, prefix, lines, { timestamps = false } = {}) {
  for (const line of lines) {
    const timestamp = timestamps ? `[${new Date().toISOString()}] ` : '';
    stream.write(`${prefix}${timestamp}${line}\n`);
  }
}

function writeWithPrefix(stream, prefix, bufState, chunk) {
  writePrefixedLines(stream, prefix, consumeLineChunk(bufState, chunk));
}

function flushLineBuffer(bufState) {
  if (!bufState.buf) return [];
  const line = bufState.buf;
  bufState.buf = '';
  return [line];
}

function flushPrefixed(stream, prefix, bufState) {
  writePrefixedLines(stream, prefix, flushLineBuffer(bufState));
}

function sanitizeLogFileToken(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const cleaned = s.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'proc';
}

export function resolveProcessTeeLogPath({ label, env } = {}) {
  const teeDir = String(env?.HAPPIER_STACK_LOG_TEE_DIR ?? '').trim();
  return teeDir ? join(teeDir, `${sanitizeLogFileToken(label)}.log`) : '';
}

function createWritableFinishController(stream) {
  if (!stream) {
    return { endAndWait: async () => {} };
  }
  let settle;
  const completion = new Promise((resolve) => {
    settle = resolve;
  });
  stream.once('finish', settle);
  stream.once('close', settle);
  stream.on('error', settle);
  let endRequested = false;
  return {
    async endAndWait() {
      if (!endRequested) {
        endRequested = true;
        try {
          stream.end();
        } catch {
          settle();
        }
      }
      await completion;
    },
  };
}

function writeChildStdinBestEffort(child, input) {
  const stdin = child?.stdin;
  if (!stdin) return;
  // Pipe errors are emitted asynchronously, so a try/catch around write/end is insufficient.
  // The child exit code remains the command outcome when it intentionally closes stdin early.
  stdin.on('error', () => {});
  try {
    stdin.end(String(input));
  } catch {
    // The child may exit synchronously before its stdin stream is writable.
  }
}

const DEFAULT_FAILURE_DIAGNOSTIC_MAX_CHARS = 16_000;
const SECRET_ENV_KEY_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export function appendBoundedTail(current, chunk, maxChars) {
  const next = `${current}${chunk.toString()}`;
  return next.length > maxChars ? next.slice(-maxChars) : next;
}

function redactFailureDiagnostic(output, env) {
  let redacted = String(output ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(
      /^(\s*[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*).+$/gim,
      '$1<redacted>',
    );
  const secretValues = Object.entries(env ?? {})
    .filter(([key, value]) => SECRET_ENV_KEY_PATTERN.test(key) && String(value ?? '').length >= 4)
    .map(([, value]) => String(value))
    .sort((left, right) => right.length - left.length);
  for (const value of secretValues) {
    redacted = redacted.replaceAll(value, '<redacted>');
  }
  return redacted.trim();
}

export function formatFailureDiagnostic({ out, err, truncated, env }) {
  const sections = [];
  const sanitizedOut = redactFailureDiagnostic(out, env);
  const sanitizedErr = redactFailureDiagnostic(err, env);
  if (sanitizedOut) sections.push(`[stdout]\n${sanitizedOut}`);
  if (sanitizedErr) sections.push(`[stderr]\n${sanitizedErr}`);
  if (sections.length === 0) return '';
  return `\n\nChild output${truncated ? ' (tail; earlier output omitted)' : ''}:\n${sections.join('\n')}`;
}

export function spawnProc(label, cmd, args, env, options = {}) {
  const {
    silent = false,
    persistOutput = true,
    teeFile,
    teeLabel,
    teeMaxBytes = DEFAULT_TEE_MAX_BYTES,
    lineFilter,
    onLine,
    ...spawnOptions
  } = options ?? {};

  const { shell: shellOverride, ...spawnOptionsRest } = spawnOptions ?? {};
  const invocation = resolveProcSpawnInvocation(cmd, args, env, shellOverride);

  const outState = { buf: '' };
  const errState = { buf: '' };
  const outPrefix = `[${label}] `;
  const errPrefix = `[${label}] `;

  let teePath = persistOutput && typeof teeFile === 'string' && teeFile.trim() ? teeFile.trim() : '';
  if (persistOutput && !teePath) {
    teePath = resolveProcessTeeLogPath({ label, env });
    if (teePath) {
      try {
        mkdirSync(dirname(teePath), { recursive: true });
      } catch {
        // ignore
      }
    }
  }
  const teeStream = teePath ? createBoundedLogWriteStream(teePath, teeMaxBytes) : null;
  const teeFinish = createWritableFinishController(teeStream);
  const teePrefix = (() => {
    const t = typeof teeLabel === 'string' ? teeLabel.trim() : '';
    if (t) return `[${t}] `;
    return outPrefix;
  })();
  const teeTimestamps = String(env?.HAPPIER_STACK_LOG_TEE_TIMESTAMPS ?? '') === '1';

  const emitLines = (stream, lines) => {
    if (typeof onLine !== 'function') return;
    for (const line of lines) {
      try {
        onLine({ stream, line });
      } catch {
        // ignore observer failures; child process logging should stay best-effort
      }
    }
  };

  const filterLines = (stream, lines) => {
    if (typeof lineFilter !== 'function') return lines;
    return lines.filter((line) => {
      try {
        return lineFilter({ stream, line }) !== false;
      } catch {
        // A display optimization must never hide child output after its filter fails.
        return true;
      }
    });
  };

  const child = spawn(invocation.command, invocation.args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...invocation.spawnOptions,
    // Create a new process group so we can kill the whole tree reliably on shutdown.
    detached: process.platform !== 'win32',
    ...spawnOptionsRest,
  });
  let spawnError = null;
  child.on('error', (error) => {
    spawnError ??= error;
  });

  child.stdout?.on('data', (d) => {
    const lines = filterLines('stdout', consumeLineChunk(outState, d));
    emitLines('stdout', lines);
    if (!silent) writePrefixedLines(process.stdout, outPrefix, lines);
    if (teeStream) writePersistedLogLines(teeStream, teePrefix, lines, { timestamps: teeTimestamps });
  });
  child.stderr?.on('data', (d) => {
    const lines = filterLines('stderr', consumeLineChunk(errState, d));
    emitLines('stderr', lines);
    if (!silent) writePrefixedLines(process.stderr, errPrefix, lines);
    if (teeStream) writePersistedLogLines(teeStream, teePrefix, lines, { timestamps: teeTimestamps });
  });
  child.completion = new Promise((resolve) => child.on('close', async (code, signal) => {
    child.__happierClosed = true;
    const outLines = filterLines('stdout', flushLineBuffer(outState));
    const errLines = filterLines('stderr', flushLineBuffer(errState));
    emitLines('stdout', outLines);
    emitLines('stderr', errLines);
    if (!silent) {
      writePrefixedLines(process.stdout, outPrefix, outLines);
      writePrefixedLines(process.stderr, errPrefix, errLines);
    }
    if (teeStream) {
      writePersistedLogLines(teeStream, teePrefix, outLines, { timestamps: teeTimestamps });
      writePersistedLogLines(teeStream, teePrefix, errLines, { timestamps: teeTimestamps });
    }
    await teeFinish.endAndWait();
    resolve({
      code: spawnError ? null : code,
      signal: signal ?? null,
      ...(spawnError ? { error: spawnError } : {}),
    });
  }));
  child.on('exit', (code, sig) => {
    if (code !== 0) {
      const streamLine = formatSpawnedProcessExitLine(`[${label}]`, code, sig, child);
      if (!silent) {
        process.stderr.write(streamLine);
      }
      if (teeStream) {
        try {
          const persistedExitPrefix = teeTimestamps
            ? `${teePrefix}[${new Date().toISOString()}] `
            : teePrefix;
          teeStream.write(formatSpawnedProcessExitLine(persistedExitPrefix, code, sig, child));
        } catch {
          // ignore
        }
      }
    }
  });

  return child;
}

export async function killProcessTree(child, signal, { graceMs = 800, boundary } = {}) {
  if (!child) {
    return { ok: true, alreadyExited: true };
  }
  const platform = boundary?.platform ?? process.platform;
  if (
    platform === 'win32'
    && (child.exitCode != null || child.signalCode != null || child.__happierClosed === true)
  ) {
    return { ok: false, reason: 'leader_absent_without_tree_proof' };
  }

  if (!child.pid) {
    try {
      return { ok: child.kill?.(signal) !== false, signal };
    } catch {
      return { ok: false, reason: 'missing_pid_kill_failed' };
    }
  }

  return await terminateProcessGroup(child.pid, { graceMs, signal, boundary });
}

export async function run(cmd, args, options = {}) {
  const {
    timeoutMs,
    input,
    shell: shellOverride,
    stdio: stdioOverride,
    captureFailureDiagnostic = false,
    ...spawnOptions
  } = options ?? {};
  const invocation = resolveProcSpawnInvocation(cmd, args, spawnOptions.env ?? process.env, shellOverride);
  await new Promise((resolvePromise, rejectPromise) => {
    const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const baseStdio = stdioOverride ?? 'inherit';
    const captureOptions = captureFailureDiagnostic && typeof captureFailureDiagnostic === 'object'
      ? captureFailureDiagnostic
      : {};
    const shouldCaptureFailure = Boolean(captureFailureDiagnostic);
    const maxCharsRaw = Number(captureOptions.maxChars);
    const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0
      ? Math.trunc(maxCharsRaw)
      : DEFAULT_FAILURE_DIAGNOSTIC_MAX_CHARS;
    const streamMaxChars = Math.max(1, Math.floor(maxChars / 2));
    const stdio = shouldCaptureFailure
      ? [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe']
      : input != null
        ? Array.isArray(baseStdio)
          ? ['pipe', baseStdio[1] ?? 'inherit', baseStdio[2] ?? 'inherit']
          : ['pipe', baseStdio, baseStdio]
        : baseStdio;

    const proc = spawn(invocation.command, invocation.args, {
      ...invocation.spawnOptions,
      ...spawnOptions,
      stdio,
      ...(timeoutEnabled && process.platform !== 'win32' ? { detached: true } : {}),
    });
    let timedOut = false;
    let settled = false;
    let timeout = null;
    const clearRunTimeout = () => {
      if (!timeout) return;
      clearTimeout(timeout);
      timeout = null;
    };
    let capturedOut = '';
    let capturedErr = '';
    let failureDiagnosticTruncated = false;
    if (shouldCaptureFailure) {
      proc.stdout?.on('data', (chunk) => {
        const nextLength = capturedOut.length + chunk.length;
        failureDiagnosticTruncated ||= nextLength > streamMaxChars;
        capturedOut = appendBoundedTail(capturedOut, chunk, streamMaxChars);
      });
      proc.stderr?.on('data', (chunk) => {
        const nextLength = capturedErr.length + chunk.length;
        failureDiagnosticTruncated ||= nextLength > streamMaxChars;
        capturedErr = appendBoundedTail(capturedErr, chunk, streamMaxChars);
      });
    }
    if (input != null && proc.stdin) {
      writeChildStdinBestEffort(proc, input);
    }
    timeout = timeoutEnabled
      ? setTimeout(() => {
          timedOut = true;
          void killProcessTree(proc, 'SIGKILL', { graceMs: 2_000 }).then((cleanup) => {
            const e = new Error(`${cmd} timed out after ${timeoutMs}ms`);
            e.code = 'ETIMEDOUT';
            if (!cleanup.ok) {
              e.cleanup = cleanup;
              e.message += `; process-tree cleanup was not confirmed (${cleanup.reason ?? 'unknown'})`;
            }
            settled = true;
            rejectPromise(e);
          }, (cleanupError) => {
            const e = new Error(`${cmd} timed out after ${timeoutMs}ms; process-tree cleanup failed`);
            e.code = 'ETIMEDOUT';
            e.cause = cleanupError;
            settled = true;
            rejectPromise(e);
          });
        }, timeoutMs)
      : null;
    proc.on('error', (error) => {
      if (timedOut || settled) return;
      clearRunTimeout();
      settled = true;
      rejectPromise(error);
    });
    proc.on('close', (code, signal) => {
      clearRunTimeout();
      if (timedOut || settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise();
        return;
      }
      const sig = signal ?? 'null';
      const resolvedCode = code ?? 'null';
      const failureDiagnostic = shouldCaptureFailure
        ? formatFailureDiagnostic({
            out: capturedOut,
            err: capturedErr,
            truncated: failureDiagnosticTruncated,
            env: captureOptions.env ?? spawnOptions.env ?? process.env,
          })
        : '';
      const e = new Error(`${cmd} failed (code=${resolvedCode}, sig=${sig})${failureDiagnostic}`);
      e.code = 'EEXIT';
      e.exitCode = code;
      e.signal = signal;
      rejectPromise(e);
    });
  });
}

export async function runCapture(cmd, args, options = {}) {
  const { timeoutMs, shell: shellOverride, stdio: _stdioOverride, ...spawnOptions } = options ?? {};
  const invocation = resolveProcSpawnInvocation(cmd, args, spawnOptions.env ?? process.env, shellOverride);
  return await new Promise((resolvePromise, rejectPromise) => {
    const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const proc = spawn(invocation.command, invocation.args, {
      ...invocation.spawnOptions,
      ...spawnOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(timeoutEnabled && process.platform !== 'win32' ? { detached: true } : {}),
    });
    let out = '';
    let err = '';
    let settled = false;
    const rejectTimedOut = () => {
      const e = new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`);
      e.code = 'ETIMEDOUT';
      e.out = out;
      e.err = err;
      rejectPromise(e);
    };
    const t = timeoutEnabled
      ? setTimeout(() => {
          if (settled) return;
          // A kernel-stuck child can never emit close. The deadline belongs to
          // the caller, while process-tree cleanup remains best-effort.
          void killProcessTree(proc, 'SIGKILL', { graceMs: 2_000 }).catch(() => {});
          settled = true;
          rejectTimedOut();
        }, timeoutMs)
      : null;
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', (error) => {
      if (settled) return;
      if (t) clearTimeout(t);
      settled = true;
      rejectPromise(error);
    });
    proc.on('close', (code, signal) => {
      if (t) clearTimeout(t);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise(out);
        return;
      }
      const diagnosticStreamMaxChars = Math.max(1, Math.floor(DEFAULT_FAILURE_DIAGNOSTIC_MAX_CHARS / 2));
      const diagnosticOut = appendBoundedTail('', out, diagnosticStreamMaxChars);
      const diagnosticErr = appendBoundedTail('', err, diagnosticStreamMaxChars);
      const failureDiagnostic = formatFailureDiagnostic({
        out: diagnosticOut,
        err: diagnosticErr,
        truncated: out.length > diagnosticStreamMaxChars || err.length > diagnosticStreamMaxChars,
        env: spawnOptions.env ?? process.env,
      });
      const e = new Error(
        `${cmd} ${args.join(' ')} failed (code=${code ?? 'null'}, sig=${signal ?? 'null'})${failureDiagnostic}`
      );
      e.code = 'EEXIT';
      e.exitCode = code;
      e.signal = signal;
      e.out = out;
      e.err = err;
      rejectPromise(e);
    });
  });
}

export async function runCaptureResult(cmd, args, options = {}) {
  const {
    timeoutMs,
    streamLabel,
    teeFile,
    teeLabel,
    teeMaxBytes = DEFAULT_TEE_MAX_BYTES,
    input,
    heartbeatMs,
    shell: shellOverride,
    ...spawnOptions
  } = options ?? {};
  const startedAt = Date.now();
  return await new Promise((resolvePromise) => {
    const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const stdio = input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const invocation = resolveProcSpawnInvocation(cmd, args, spawnOptions.env ?? process.env, shellOverride);
    const proc = spawn(invocation.command, invocation.args, {
      stdio,
      ...invocation.spawnOptions,
      ...spawnOptions,
      ...(timeoutEnabled && process.platform !== 'win32' ? { detached: true } : {}),
    });
    let out = '';
    let err = '';
    const label = String(streamLabel ?? '').trim();
    const shouldStream = Boolean(label);
    const outState = { buf: '' };
    const errState = { buf: '' };
    const prefix = shouldStream ? `[${label}] ` : '';

    const teePath = String(teeFile ?? '').trim();
    const shouldTee = Boolean(teePath);
    const teeOutState = { buf: '' };
    const teeErrState = { buf: '' };
    const teePrefix = (() => {
      const t = String(teeLabel ?? '').trim();
      if (t) return `[${t}] `;
      if (label) return `[${label}] `;
      return '';
    })();
    const teeStream = shouldTee ? createBoundedLogWriteStream(teePath, teeMaxBytes) : null;
    const teeFinish = createWritableFinishController(teeStream);
    const keepaliveEveryMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 0;
    let terminalOverride = null;
    let timeoutCleanup = null;
    let resolved = false;

    function writeKeepaliveLine(line) {
      if (shouldStream) process.stdout.write(`${prefix}${line}\n`);
      if (shouldTee && teeStream) teeStream.write(`${teePrefix}${line}\n`);
    }

    async function resolveWith(res) {
      if (resolved) return;
      resolved = true;
      if (shouldStream) {
        flushPrefixed(process.stdout, prefix, outState);
        flushPrefixed(process.stderr, prefix, errState);
      }
      if (shouldTee && teeStream) {
        flushPrefixed(teeStream, teePrefix, teeOutState);
        flushPrefixed(teeStream, teePrefix, teeErrState);
      }
      await teeFinish.endAndWait();
      resolvePromise(res);
    }
    const hb =
      keepaliveEveryMs > 0
        ? setInterval(() => {
            const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
            writeKeepaliveLine(`still running (elapsed ${elapsedSec}s, pid=${proc.pid})`);
          }, keepaliveEveryMs)
        : null;
    const t = timeoutEnabled
      ? setTimeout(() => {
          terminalOverride = { kind: 'timeout' };
          timeoutCleanup = killProcessTree(proc, 'SIGKILL', { graceMs: 2_000 }).then(
            (cleanup) => ({ cleanup, error: null }),
            (error) => ({ cleanup: null, error }),
          );
          if (hb) clearInterval(hb);
        }, timeoutMs)
      : null;
    proc.stdout?.on('data', (d) => {
      out += d.toString();
      if (shouldStream) writeWithPrefix(process.stdout, prefix, outState, d);
      if (shouldTee && teeStream) writeWithPrefix(teeStream, teePrefix, teeOutState, d);
    });
    proc.stderr?.on('data', (d) => {
      err += d.toString();
      if (shouldStream) writeWithPrefix(process.stderr, prefix, errState, d);
      if (shouldTee && teeStream) writeWithPrefix(teeStream, teePrefix, teeErrState, d);
    });

    if (input != null && proc.stdin) {
      writeChildStdinBestEffort(proc, input);
    }
    proc.on('error', (e) => {
      if (t) clearTimeout(t);
      if (hb) clearInterval(hb);
      terminalOverride = { kind: 'error', error: e };
    });
    proc.on('close', async (code, signal) => {
      if (t) clearTimeout(t);
      if (hb) clearInterval(hb);
      let cleanup = null;
      if (terminalOverride?.kind === 'timeout') {
        const outcome = await timeoutCleanup;
        cleanup = outcome.error
          ? { ok: false, reason: 'cleanup_failed', error: outcome.error }
          : outcome.cleanup;
      }
      const finishedAt = Date.now();
      const errorSuffix = terminalOverride?.kind === 'error'
        ? (err.endsWith('\n') || !err ? '' : '\n') + String(terminalOverride.error) + '\n'
        : '';
      resolveWith({
        ok: terminalOverride == null && code === 0,
        exitCode: terminalOverride ? null : code,
        signal: terminalOverride ? null : signal ?? null,
        out,
        err: err + errorSuffix,
        timedOut: terminalOverride?.kind === 'timeout',
        ...(terminalOverride?.kind === 'timeout' && !cleanup?.ok ? { cleanup } : {}),
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    });
  });
}
