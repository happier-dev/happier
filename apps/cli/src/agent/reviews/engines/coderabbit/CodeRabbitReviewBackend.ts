import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { SessionId } from '../../../core/AgentBackend';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '../../../runtime/bridges/executionRun/executionRunHostRuntime';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { readCodeRabbitReviewConfigFromEnv } from './readCodeRabbitReviewConfig.js';
import { buildCodeRabbitEnv } from './buildCodeRabbitEnv.js';
import { runWithCodeRabbitRateLimitRetries } from './runWithRateLimitRetries.js';
import { resolveCodeRabbitBaseRef } from './preflightCodeRabbitReviewScope.js';
import { normalizeCodeRabbitReviewStartInput } from './normalizeCodeRabbitReviewStartInput.js';

type PendingProcess = Readonly<{
  kill: () => void;
  done: Promise<void>;
}>;

type CodeRabbitStartContext = Readonly<{
  intentInput?: unknown;
}>;

// CodeRabbit review runs are native execution-run leaves. Keep any legacy AgentBackend
// compatibility outside this provider leaf in the shared testkit/descriptor shim path.
export class CodeRabbitReviewBackend implements ExecutionRunHostRuntime {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly config: ReturnType<typeof readCodeRabbitReviewConfigFromEnv>;
  private readonly start: CodeRabbitStartContext | null;

  private readonly pendingBySessionId = new Map<SessionId, PendingProcess>();
  private readonly messageHandlers = new Set<ExecutionRunHostRuntimeMessageHandler>();

  constructor(params: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; start?: CodeRabbitStartContext }>) {
    this.cwd = params.cwd;
    this.env = params.env ?? process.env;
    this.config = readCodeRabbitReviewConfigFromEnv(this.env);
    this.start = params.start ?? null;
  }

  async readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean> {
    void opts;
    return false;
  }

  async provisionSession(opts?: Readonly<{
    initialPrompt?: string;
    resumeSessionId?: string;
    captureReplay?: boolean;
  }>): Promise<{ sessionId: SessionId }> {
    if (opts?.captureReplay === true) {
      throw new Error('CodeRabbit execution runs do not support replay capture');
    }
    if (typeof opts?.resumeSessionId === 'string' && opts.resumeSessionId.trim().length > 0) {
      throw new Error('CodeRabbit execution runs do not support session resume');
    }
    const started = { sessionId: `coderabbit_${randomUUID()}` as SessionId };
    const initialPrompt = typeof opts?.initialPrompt === 'string' ? opts.initialPrompt : '';
    if (initialPrompt.trim()) {
      await this.sendPrompt(started.sessionId, initialPrompt);
    }
    return started;
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    const existing = this.pendingBySessionId.get(sessionId);
    if (existing) {
      throw new Error('CodeRabbit backend is busy');
    }

    const args = await (async () => {
      const rawIntentInput: any = this.start?.intentInput ?? null;
      const reviewInput = normalizeCodeRabbitReviewStartInput({
        intentInput: rawIntentInput ?? {},
        fallbackInstructions: prompt,
      });
      const changeType = reviewInput.changeType;

      const cfg = reviewInput.engines?.coderabbit ?? null;
      const configFiles: string[] = Array.isArray(cfg?.configFiles) ? cfg.configFiles : [];
      const plain = cfg?.plain !== false;
      const promptOnly = cfg?.promptOnly === true;

      const out: string[] = ['review', '--no-color', '--cwd', this.cwd, '--type', changeType];
      if (plain) out.push('--plain');
      if (promptOnly) out.push('--prompt-only');

      const resolvedBaseRef = await resolveCodeRabbitBaseRef({ cwd: this.cwd, reviewInput });
      if (reviewInput.base.kind === 'commit' && resolvedBaseRef) {
        out.push('--base-commit', resolvedBaseRef);
      } else if (resolvedBaseRef) {
        out.push('--base', resolvedBaseRef);
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
      if (process.platform === 'win32') {
        void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
        return;
      }
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    };

    type AttemptResult = Readonly<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }>;

    const runOnce = async (): Promise<AttemptResult> => {
      if (aborted) return { ok: false, stdout: '', stderr: 'cancelled', exitCode: null };

      const env = buildCodeRabbitEnv({ baseEnv: this.env, homeDir: this.config.homeDir });
      const invocation = resolveWindowsCommandInvocation({
        command: this.config.command,
        args,
        env,
        resolveCommandOnPath: true,
      });

      const child = spawn(invocation.command, invocation.args, {
        cwd: this.cwd,
        env,
        stdio: 'pipe',
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
        let timedOut = false;

        const timer =
          typeof this.config.timeoutMs === 'number'
            ? setTimeout(() => {
              timedOut = true;
              if (process.platform === 'win32') {
                void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
              } else {
                try { child.kill('SIGTERM'); } catch {}
              }
            }, this.config.timeoutMs)
            : null;

        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (timedOut) {
            resolve({ ok: false, stdout, stderr: stderr || 'CodeRabbit timed out', exitCode: null });
            return;
          }
          if (aborted) {
            resolve({ ok: false, stdout, stderr: stderr || 'cancelled', exitCode: null });
            return;
          }
          resolve({ ok: false, stdout, stderr: errorMessage, exitCode: null });
        });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          if (timedOut) {
            resolve({ ok: false, stdout, stderr: stderr || 'CodeRabbit timed out', exitCode: typeof code === 'number' ? code : null });
            return;
          }
          if (aborted) {
            resolve({ ok: false, stdout, stderr: stderr || 'cancelled', exitCode: typeof code === 'number' ? code : null });
            return;
          }
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
        maxTotalRetrySleepMs: this.config.timeoutMs,
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

      this.emitMessage({ type: 'model-output', fullText: res.stdout });
    })().finally(() => {
      childRef.current = null;
      this.pendingBySessionId.delete(sessionId);
    });

    this.pendingBySessionId.set(sessionId, { kill, done });

    await done;
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const pending = this.pendingBySessionId.get(sessionId);
    if (!pending) {
      return;
    }
    pending.kill();
    await pending.done.catch(() => undefined);
  }

  subscribeMessages(handler: ExecutionRunHostRuntimeMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  async dispose(): Promise<void> {
    const pendingProcesses = [...this.pendingBySessionId.values()];
    for (const pending of pendingProcesses) {
      pending.kill();
    }
    await Promise.allSettled(pendingProcesses.map(async (pending) => {
      await pending.done;
    }));
    this.pendingBySessionId.clear();
  }

  private emitMessage(message: Parameters<ExecutionRunHostRuntimeMessageHandler>[0]): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}
