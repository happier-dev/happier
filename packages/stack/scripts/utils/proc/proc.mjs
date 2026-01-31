import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

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

function writeWithPrefix(stream, prefix, bufState, chunk) {
  const s = chunk.toString();
  bufState.buf += s;
  while (true) {
    const idx = nextLineBreakIndex(bufState.buf);
    if (idx < 0) break;
    const line = bufState.buf.slice(0, idx);
    bufState.buf = consumeLineBreak(bufState.buf.slice(idx));
    stream.write(`${prefix}${line}\n`);
  }
}

function flushPrefixed(stream, prefix, bufState) {
  if (!bufState.buf) return;
  stream.write(`${prefix}${bufState.buf}\n`);
  bufState.buf = '';
}

export function spawnProc(label, cmd, args, env, options = {}) {
  const { silent = false, teeFile, teeLabel, ...spawnOptions } = options ?? {};
  const child = spawn(cmd, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    // Create a new process group so we can kill the whole tree reliably on shutdown.
    detached: process.platform !== 'win32',
    ...spawnOptions,
  });

  const outState = { buf: '' };
  const errState = { buf: '' };
  const outPrefix = `[${label}] `;
  const errPrefix = `[${label}] `;

  const teePath = typeof teeFile === 'string' && teeFile.trim() ? teeFile.trim() : '';
  const teeStream = teePath ? createWriteStream(teePath, { flags: 'a' }) : null;
  const teeOutState = { buf: '' };
  const teeErrState = { buf: '' };
  const teePrefix = (() => {
    const t = typeof teeLabel === 'string' ? teeLabel.trim() : '';
    if (t) return `[${t}] `;
    return outPrefix;
  })();

  child.stdout?.on('data', (d) => {
    if (!silent) writeWithPrefix(process.stdout, outPrefix, outState, d);
    if (teeStream) writeWithPrefix(teeStream, teePrefix, teeOutState, d);
  });
  child.stderr?.on('data', (d) => {
    if (!silent) writeWithPrefix(process.stderr, errPrefix, errState, d);
    if (teeStream) writeWithPrefix(teeStream, teePrefix, teeErrState, d);
  });
  child.on('close', () => {
    if (!silent) {
      flushPrefixed(process.stdout, outPrefix, outState);
      flushPrefixed(process.stderr, errPrefix, errState);
    }
    if (teeStream) {
      flushPrefixed(teeStream, teePrefix, teeOutState);
      flushPrefixed(teeStream, teePrefix, teeErrState);
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
  if (!child || child.exitCode != null || !child.pid) {
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
    // ignore
  }
}

export async function run(cmd, args, options = {}) {
  const { timeoutMs, input, ...spawnOptions } = options ?? {};
  await new Promise((resolvePromise, rejectPromise) => {
    const baseStdio = spawnOptions.stdio ?? 'inherit';
    const stdio =
      input != null
        ? Array.isArray(baseStdio)
          ? ['pipe', baseStdio[1] ?? 'inherit', baseStdio[2] ?? 'inherit']
          : ['pipe', baseStdio, baseStdio]
        : baseStdio;

    const proc = spawn(cmd, args, { stdio, shell: false, ...spawnOptions });
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
  const { timeoutMs, ...spawnOptions } = options ?? {};
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...spawnOptions });
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
  const { timeoutMs, streamLabel, teeFile, teeLabel, ...spawnOptions } = options ?? {};
  const startedAt = Date.now();
  return await new Promise((resolvePromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...spawnOptions });
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
    }    const t =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
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
    proc.on('error', (e) => {
      if (t) clearTimeout(t);
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
