import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

export function spawnProc(label, cmd, args, env, options = {}) {
  const {
    silent = false,
    teeFile,
    teeLabel,
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
  const teeStream = teePath ? createWriteStream(teePath, { flags: 'a' }) : null;
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
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    // Create a new process group so we can kill the whole tree reliably on shutdown.
    detached: process.platform !== 'win32',
    ...spawnOptionsRest,
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
  child.on('close', () => {
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
      try {
        teeStream.end();
      } catch {
        // ignore
      }
    }
  });
  child.on('exit', (code, sig) => {
    if (code !== 0) {
      if (!silent) {
        process.stderr.write(`[${label}] exited (code=${code}, sig=${sig})\n`);
      }
      if (teeStream) {
        try {
          teeStream.write(`${teePrefix.trimEnd()} exited (code=${code}, sig=${sig})\n`);
        } catch {
          // ignore
        }
      }
    }
  });

  return child;
}

export function killProcessTree(child, signal) {
  if (!child || child.exitCode != null) {
    return;
  }

  if (!child.pid) {
    try {
      child.kill?.(signal);
    } catch {
      // ignore
    }
    return;
  }

  try {
    if (process.platform !== 'win32') {
      // Kill the process group.
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill?.(signal);
    } catch {
      // ignore
    }
  }
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

    const proc = spawn(cmd, args, { shell, ...spawnOptions, stdio });
    if (input != null && proc.stdin) {
      try {
        proc.stdin.write(String(input));
        proc.stdin.end();
      } catch {
        // ignore
      }
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
  const { timeoutMs, shell: shellOverride, stdio: _stdioOverride, ...spawnOptions } = options ?? {};
  const shell = typeof shellOverride === 'boolean' ? shellOverride : resolveDefaultShellForCommand(cmd);
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { shell, ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
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
            rejectPromise(e);
          }, timeoutMs)
        : null;
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', rejectPromise);
    proc.on('exit', (code, signal) => {
      if (t) clearTimeout(t);
      if (code === 0) {
        resolvePromise(out);
      } else {
        const e = new Error(
          `${cmd} ${args.join(' ')} failed (code=${code ?? 'null'}, sig=${signal ?? 'null'}): ${err.trim()}`
        );
        e.code = 'EEXIT';
        e.exitCode = code;
        e.signal = signal;
        e.out = out;
        e.err = err;
        rejectPromise(e);
      }
    });
  });
}

export async function runCaptureResult(cmd, args, options = {}) {
  const { timeoutMs, streamLabel, teeFile, teeLabel, input, heartbeatMs, ...spawnOptions } = options ?? {};
  const startedAt = Date.now();
  return await new Promise((resolvePromise) => {
    const stdio = input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const proc = spawn(cmd, args, { stdio, shell: false, ...spawnOptions });
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
    const keepaliveEveryMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 0;

    function writeKeepaliveLine(line) {
      if (shouldStream) process.stdout.write(`${prefix}${line}\n`);
      if (shouldTee && teeStream) teeStream.write(`${teePrefix}${line}\n`);
    }

    function resolveWith(res) {
      if (shouldStream) {
        flushPrefixed(process.stdout, prefix, outState);
        flushPrefixed(process.stderr, prefix, errState);
      }
      if (shouldTee && teeStream) {
        flushPrefixed(teeStream, teePrefix, teeOutState);
        flushPrefixed(teeStream, teePrefix, teeErrState);
        try {
          teeStream.end();
        } catch {
          // ignore
        }
      }
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
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
            if (hb) clearInterval(hb);
            resolveWith({
              ok: false,
              exitCode: null,
              signal: null,
              out,
              err,
              timedOut: true,
              startedAt,
              finishedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            });
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
      try {
        proc.stdin.write(String(input));
        proc.stdin.end();
      } catch {
        // ignore
      }
    }
    proc.on('error', (e) => {
      if (t) clearTimeout(t);
      if (hb) clearInterval(hb);
      resolveWith({
        ok: false,
        exitCode: null,
        signal: null,
        out,
        err: err + (err.endsWith('\n') || !err ? '' : '\n') + String(e) + '\n',
        timedOut: false,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    });
    proc.on('close', (code, signal) => {
      if (t) clearTimeout(t);
      if (hb) clearInterval(hb);
      resolveWith({
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        out,
        err,
        timedOut: false,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
