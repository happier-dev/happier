import { spawn } from 'node:child_process';
import {
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { terminateProcessGroup } from './terminate.mjs';

const plannedExitMarker = Symbol('happier.stack.plannedExit');
const DEFAULT_TEE_MAX_BYTES = 16 * 1024 * 1024;

export function resolveDefaultShellForCommand(cmd, { platform = process.platform } = {}) {
  if (platform !== 'win32') return false;
  const raw = String(cmd ?? '').trim();
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  if (normalized === 'yarn' || normalized.endsWith('\\yarn') || normalized.endsWith('/yarn')) {
    // Corepack installs Yarn as a yarn.cmd shim on Windows. Without a shell, Node's spawn cannot
    // execute the .cmd wrapper (CreateProcess only handles .exe directly).
    return true;
  }
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat') || normalized.endsWith('.ps1');
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

function createBoundedTeeStream(filePath, maxBytes) {
  const normalizedMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.trunc(maxBytes)
    : DEFAULT_TEE_MAX_BYTES;
  const rotatedPath = `${filePath}.1`;
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (size > normalizedMaxBytes) {
    let descriptor = null;
    try {
      const tail = Buffer.allocUnsafe(normalizedMaxBytes);
      descriptor = openSync(filePath, 'r');
      const bytesRead = readSync(
        descriptor,
        tail,
        0,
        normalizedMaxBytes,
        size - normalizedMaxBytes,
      );
      closeSync(descriptor);
      descriptor = null;
      rmSync(rotatedPath, { force: true });
      writeFileSync(rotatedPath, tail.subarray(0, bytesRead));
      writeFileSync(filePath, '');
      size = 0;
    } catch {
      if (descriptor != null) {
        try {
          closeSync(descriptor);
        } catch {
          // Ignore cleanup failure; normal stream error handling remains authoritative.
        }
      }
    }
  }
  let writer = null;
  const openDestination = (flags) => {
    const stream = createWriteStream(filePath, { flags });
    stream.on('error', (error) => {
      if (writer && !writer.destroyed) writer.destroy(error);
    });
    return stream;
  };
  let destination = openDestination('a');

  writer = new Writable({
    write(chunk, _encoding, callback) {
      let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > normalizedMaxBytes) {
        bytes = bytes.subarray(bytes.length - normalizedMaxBytes);
      }

      const writeCurrent = () => {
        size += bytes.length;
        destination.write(bytes, callback);
      };
      if (size + bytes.length <= normalizedMaxBytes) {
        writeCurrent();
        return;
      }

      destination.end(() => {
        try {
          rmSync(rotatedPath, { force: true });
          renameSync(filePath, rotatedPath);
        } catch {
          // Rotation is best-effort. Reopening with `w` below still bounds the active file.
        }
        destination = openDestination('w');
        size = 0;
        writeCurrent();
      });
    },
    final(callback) {
      destination.end(callback);
    },
  });
  return writer;
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

export function spawnProc(label, cmd, args, env, options = {}) {
  const {
    silent = false,
    teeFile,
    teeLabel,
    teeMaxBytes = DEFAULT_TEE_MAX_BYTES,
    onLine,
    ...spawnOptions
  } = options ?? {};

  const { shell: shellOverride, ...spawnOptionsRest } = spawnOptions ?? {};
  const shell = typeof shellOverride === 'boolean' ? shellOverride : resolveDefaultShellForCommand(cmd);

  const outState = { buf: '' };
  const errState = { buf: '' };
  const outPrefix = `[${label}] `;
  const errPrefix = `[${label}] `;

  let teePath = typeof teeFile === 'string' && teeFile.trim() ? teeFile.trim() : '';
  if (!teePath) {
    const teeDir = String(env?.HAPPIER_STACK_LOG_TEE_DIR ?? '').trim();
    if (teeDir) {
      try {
        mkdirSync(teeDir, { recursive: true });
      } catch {
        // ignore
      }
      teePath = join(teeDir, `${sanitizeLogFileToken(label)}.log`);
    }
  }
  const teeStream = teePath ? createBoundedTeeStream(teePath, teeMaxBytes) : null;
  const teeFinish = createWritableFinishController(teeStream);
  const teePrefix = (() => {
    const t = typeof teeLabel === 'string' ? teeLabel.trim() : '';
    if (t) return `[${t}] `;
    return outPrefix;
  })();

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

  const child = spawn(cmd, args, {
    windowsHide: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    // Create a new process group so we can kill the whole tree reliably on shutdown.
    detached: process.platform !== 'win32',
    ...spawnOptionsRest,
  });
  let spawnError = null;
  child.on('error', (error) => {
    spawnError ??= error;
  });

  child.stdout?.on('data', (d) => {
    const lines = consumeLineChunk(outState, d);
    emitLines('stdout', lines);
    if (!silent) writePrefixedLines(process.stdout, outPrefix, lines);
    if (teeStream) writePrefixedLines(teeStream, teePrefix, lines);
  });
  child.stderr?.on('data', (d) => {
    const lines = consumeLineChunk(errState, d);
    emitLines('stderr', lines);
    if (!silent) writePrefixedLines(process.stderr, errPrefix, lines);
    if (teeStream) writePrefixedLines(teeStream, teePrefix, lines);
  });
  child.completion = new Promise((resolve) => child.on('close', async (code, signal) => {
    child.__happierClosed = true;
    const outLines = flushLineBuffer(outState);
    const errLines = flushLineBuffer(errState);
    emitLines('stdout', outLines);
    emitLines('stderr', errLines);
    if (!silent) {
      writePrefixedLines(process.stdout, outPrefix, outLines);
      writePrefixedLines(process.stderr, errPrefix, errLines);
    }
    if (teeStream) {
      writePrefixedLines(teeStream, teePrefix, outLines);
      writePrefixedLines(teeStream, teePrefix, errLines);
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
          teeStream.write(formatSpawnedProcessExitLine(teePrefix, code, sig, child));
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
  const { timeoutMs, input, shell: shellOverride, stdio: stdioOverride, ...spawnOptions } = options ?? {};
  const shell = typeof shellOverride === 'boolean' ? shellOverride : resolveDefaultShellForCommand(cmd);
  await new Promise((resolvePromise, rejectPromise) => {
    const baseStdio = stdioOverride ?? 'inherit';
    const stdio =
      input != null
        ? Array.isArray(baseStdio)
          ? ['pipe', baseStdio[1] ?? 'inherit', baseStdio[2] ?? 'inherit']
          : ['pipe', baseStdio, baseStdio]
        : baseStdio;

    const proc = spawn(cmd, args, { windowsHide: true, shell, ...spawnOptions, stdio });
    if (input != null && proc.stdin) {
      writeChildStdinBestEffort(proc, input);
    }
    const t =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
            const e = new Error(`${cmd} timed out after ${timeoutMs}ms`);
            e.code = 'ETIMEDOUT';
            rejectPromise(e);
          }, timeoutMs)
        : null;
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} failed (code=${code})`))));
    proc.on('exit', () => {
      if (t) clearTimeout(t);
    });
  });
}

export async function runCapture(cmd, args, options = {}) {
  const { timeoutMs, signal, shell: shellOverride, stdio: _stdioOverride, ...spawnOptions } = options ?? {};
  const shell = typeof shellOverride === 'boolean' ? shellOverride : resolveDefaultShellForCommand(cmd);
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { windowsHide: true, shell, ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const abortError = () => {
      const error = new Error(`${cmd} ${args.join(' ')} aborted`);
      error.code = 'ABORT_ERR';
      error.out = out;
      error.err = err;
      return error;
    };
    const cleanup = () => {
      if (t) clearTimeout(t);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onAbort = () => {
      try { proc.kill('SIGKILL'); } catch {}
      rejectOnce(abortError());
    };
    const t =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
            const e = new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`);
            e.code = 'ETIMEDOUT';
            e.out = out;
            e.err = err;
            rejectOnce(e);
          }, timeoutMs)
        : null;
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    }
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', rejectOnce);
    proc.on('exit', (code, signal) => {
      if (code === 0) {
        resolveOnce(out);
      } else {
        const e = new Error(
          `${cmd} ${args.join(' ')} failed (code=${code ?? 'null'}, sig=${signal ?? 'null'}): ${err.trim()}`
        );
        e.code = 'EEXIT';
        e.exitCode = code;
        e.signal = signal;
        e.out = out;
        e.err = err;
        rejectOnce(e);
      }
    });
  });
}

export async function runCaptureResult(cmd, args, options = {}) {
  const { timeoutMs, streamLabel, teeFile, teeLabel, input, heartbeatMs, ...spawnOptions } = options ?? {};
  const startedAt = Date.now();
  return await new Promise((resolvePromise) => {
    const stdio = input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const proc = spawn(cmd, args, { windowsHide: true, stdio, shell: false, ...spawnOptions });
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
    const teeStream = shouldTee ? createWriteStream(teePath, { flags: 'a' }) : null;
    const teeFinish = createWritableFinishController(teeStream);
    const keepaliveEveryMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 0;
    let terminalOverride = null;
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
    const t =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            terminalOverride = { kind: 'timeout' };
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
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
    proc.on('close', (code, signal) => {
      if (t) clearTimeout(t);
      if (hb) clearInterval(hb);
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
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    });
  });
}
