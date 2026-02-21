import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { ReviewStartInputSchema } from '@happier-dev/protocol';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';

import { readCodeRabbitReviewConfigFromEnv } from './readCodeRabbitReviewConfig.js';
import { buildCodeRabbitEnv } from './buildCodeRabbitEnv.js';
import { runWithCodeRabbitRateLimitRetries } from './runWithRateLimitRetries.js';

type PendingProcess = Readonly<{
  kill: () => void;
  done: Promise<void>;
}>;

type CodeRabbitStartContext = Readonly<{
  intentInput?: unknown;
}>;

export class CodeRabbitReviewBackend implements AgentBackend {
  private handler: AgentMessageHandler | null = null;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly config: ReturnType<typeof readCodeRabbitReviewConfigFromEnv>;
  private readonly start: CodeRabbitStartContext | null;

  private readonly pendingBySessionId = new Map<SessionId, PendingProcess>();

  constructor(params: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; start?: CodeRabbitStartContext }>) {
    this.cwd = params.cwd;
    this.env = params.env ?? process.env;
    this.config = readCodeRabbitReviewConfigFromEnv(this.env);
    this.start = params.start ?? null;
  }

  async startSession(): Promise<{ sessionId: SessionId }> {
    // CodeRabbit runs are stateless/one-shot; each session is a handle for cancellation.
    return { sessionId: `coderabbit_${randomUUID()}` };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    const existing = this.pendingBySessionId.get(sessionId);
    if (existing) {
      throw new Error('CodeRabbit backend is busy');
    }

    const args = (() => {
      const rawIntentInput: any = this.start?.intentInput ?? null;
      const parsed = ReviewStartInputSchema.safeParse(rawIntentInput);
      const source: any =
        parsed.success
          ? parsed.data
          : (rawIntentInput && typeof rawIntentInput === 'object')
            ? rawIntentInput
            : {};

      const changeTypeRaw = String(source?.changeType ?? '').trim();
      const changeType = changeTypeRaw === 'all' || changeTypeRaw === 'committed' || changeTypeRaw === 'uncommitted'
        ? changeTypeRaw
        : 'committed';

      const base = (source?.base && typeof source.base === 'object') ? source.base : { kind: 'none' as const };

      const cfg = source?.engines?.coderabbit ?? null;
      const configFiles: string[] = Array.isArray(cfg?.configFiles) ? cfg.configFiles : [];
      const plain = cfg?.plain !== false;
      const promptOnly = cfg?.promptOnly === true;

      const out: string[] = ['review', '--no-color', '--cwd', this.cwd, '--type', changeType];
      if (plain) out.push('--plain');
      if (promptOnly) out.push('--prompt-only');

      if (base?.kind === 'branch' && typeof (base as any).baseBranch === 'string' && String((base as any).baseBranch).trim()) {
        out.push('--base', String((base as any).baseBranch).trim());
      } else if (base?.kind === 'commit' && typeof (base as any).baseCommit === 'string' && String((base as any).baseCommit).trim()) {
        out.push('--base-commit', String((base as any).baseCommit).trim());
      }

      for (const file of configFiles) {
        const trimmed = String(file ?? '').trim();
        if (!trimmed) continue;
        out.push('--config', trimmed);
      }

      return out;
    })();

    const childRef: { current: ChildProcessWithoutNullStreams | null } = { current: null };
    let aborted = false;

    const kill = () => {
      aborted = true;
      const child = childRef.current;
      if (!child) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    };

    type AttemptResult = Readonly<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }>;

    const runOnce = async (): Promise<AttemptResult> => {
      if (aborted) return { ok: false, stdout: '', stderr: 'cancelled', exitCode: null };

      const child = spawn(this.config.command, args, {
        cwd: this.cwd,
        env: buildCodeRabbitEnv({ baseEnv: this.env, homeDir: this.config.homeDir }),
        stdio: 'pipe',
        windowsHide: true,
      });

      childRef.current = child;

      // CodeRabbit CLI is flag-driven; do not treat stdin as a prompt input.
      void prompt;
      try { child.stdin.end(); } catch {}

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });

      const res = await new Promise<AttemptResult>((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          resolve({ ok: false, stdout, stderr: stderr || 'CodeRabbit timed out', exitCode: null });
        }, this.config.timeoutMs);

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, stdout, stderr: err instanceof Error ? err.message : String(err), exitCode: null });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ ok: code === 0, stdout, stderr, exitCode: typeof code === 'number' ? code : null });
        });
      });

      if (childRef.current === child) childRef.current = null;
      if (aborted) return { ok: false, stdout, stderr: stderr || 'cancelled', exitCode: res.exitCode };
      return res;
    };

    const sleepMs = async (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    const done = (async () => {
      const res = await runWithCodeRabbitRateLimitRetries({
        maxAttempts: this.config.rateLimitMaxAttempts,
        runOnce: async (_attempt) => runOnce(),
        sleepMs: async (ms) => {
          if (aborted) return;
          await sleepMs(ms);
        },
      });

      if (!res.ok) {
        const msg = `CodeRabbit exited with code ${res.exitCode ?? 'null'}${res.stderr ? `: ${res.stderr.trim()}` : ''}`;
        throw new Error(msg);
      }

      this.handler?.({ type: 'model-output', fullText: res.stdout } as any);
    })().finally(() => {
      childRef.current = null;
      this.pendingBySessionId.delete(sessionId);
    });

    this.pendingBySessionId.set(sessionId, { kill, done });

    await done;
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const pending = this.pendingBySessionId.get(sessionId);
    pending?.kill();
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handler = handler;
  }

  async dispose(): Promise<void> {
    for (const pending of this.pendingBySessionId.values()) {
      pending.kill();
    }
    this.pendingBySessionId.clear();
  }
}
