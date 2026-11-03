import type {
  AgentAcpProviderTurnSource,
  AgentAcpProviderTurnSourceFactory,
  AgentAcpProviderTurnSink,
  AgentAcpCompletionEvidenceOutcome,
  AgentAcpProviderTurnSourceHost,
  AgentTranscriptFileFollowHandle,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AcpProviderJournalFollower } from '@/plugins/runtime/context/transcripts/acpProviderJournal';

export type AcpProviderTurnLifecycle = Readonly<{
  registerContinuation(input: Readonly<{ id: string; parentToolCallId: string }>): boolean;
  beginContinuation(input: Readonly<{ id: string; turnId: string }>): boolean;
  releaseToolCalls(toolCallIds: readonly string[]): void;
  foregroundActive?(): boolean;
  flush?(): Promise<void>;
  dispose(): void;
}>;

export type AcpProviderTurnDriver = Readonly<{
  sessionId(): string | null;
  cwd: string;
  env(): AgentAcpProviderTurnSourceHost['env'];
  followJournal?: AcpProviderJournalFollower;
  isDisposed(): boolean;
  foregroundActive(): boolean;
  canBegin(): boolean;
  begin(): void;
  update(update: Readonly<Record<string, unknown>>): Promise<void>;
  finish(outcome: AgentAcpCompletionEvidenceOutcome): Promise<void>;
  fail(error: Error): void;
}>;

/** Owns the live source lifetime. Public turn custody remains with the composer. */
export class AcpProviderTurns {
  private source: AgentAcpProviderTurnSource | null = null;
  private lifetime: AbortController | null = null;
  private active: object | null = null;
  private journal: AgentTranscriptFileFollowHandle | null = null;

  constructor(
    private readonly factory: AgentAcpProviderTurnSourceFactory,
    private readonly lifecycle: AcpProviderTurnLifecycle,
    private readonly driver: AcpProviderTurnDriver,
  ) {}

  isActive(): boolean { return this.active !== null; }
  isOpen(): boolean { return this.source !== null; }

  /** Revoke admission first and attempt every observer cleanup even if another one throws. */
  async stop(): Promise<void> {
    const source = this.source;
    this.source = null;
    this.lifetime?.abort();
    this.lifetime = null;
    this.active = null;
    const journal = this.journal;
    this.journal = null;
    await Promise.all([
      Promise.resolve().then(() => this.lifecycle.dispose()),
      Promise.resolve().then(() => source?.dispose()),
      Promise.resolve().then(() => journal?.close({ finalDrain: false })),
    ]);
  }

  async catchUp(permissionToolCallId?: string): Promise<void> {
    const source = this.source;
    const lifetime = this.lifetime;
    const assertCurrent = () => {
      if (source && (this.source !== source || this.lifetime !== lifetime || lifetime?.signal.aborted)) {
        throw new Error('ACP journal source stopped during request admission');
      }
    };
    await source?.catchUp({
      ...(permissionToolCallId ? { permissionToolCallId } : {}),
      foregroundActive: this.driver.foregroundActive()
        || (!this.isActive() && this.lifecycle.foregroundActive?.() === true),
      signal: lifetime?.signal,
    });
    assertCurrent();
    await this.lifecycle.flush?.();
    assertCurrent();
  }

  async start(): Promise<void> {
    await this.stop();
    const sessionId = this.driver.sessionId();
    if (!sessionId) return;
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    const current = () => !this.driver.isDisposed() && !lifetime.signal.aborted
      && this.lifetime === lifetime && this.driver.sessionId() === sessionId;
    let followed = false;
    let source: AgentAcpProviderTurnSource;
    try {
      source = await this.factory({
        sessionId, cwd: this.driver.cwd, env: this.driver.env(), signal: lifetime.signal,
        followJournal: async input => {
          if (!current() || followed || !this.driver.followJournal) throw new Error('ACP journal source is unavailable');
          followed = true;
          const journal = await this.driver.followJournal({ providerSessionId: sessionId, signal: lifetime.signal }, input);
          if (!current()) { await journal.close({ finalDrain: false }); throw new Error('ACP journal source stopped'); }
          this.journal = journal;
          return journal;
        },
        registerContinuation: input => current() && this.lifecycle.registerContinuation(input),
        releaseToolCalls: ids => { if (current()) this.lifecycle.releaseToolCalls(ids); },
        beginContinuation: input => {
          if (!current() || this.active || !this.driver.canBegin()
            || !this.lifecycle.beginContinuation(input)) return null;
          this.driver.begin();
          const active = {};
          this.active = active;
          let tail = Promise.resolve();
          let finishing = false;
          const ownsTurn = () => current() && this.active === active;
          const enqueue = (operation: () => Promise<void>) => {
            const next = tail.then(async () => { if (ownsTurn()) await operation(); });
            tail = next.catch(error => { if (ownsTurn()) this.driver.fail(error instanceof Error ? error : new Error('Provider continuation failed')); });
            return next;
          };
          return {
            update: update => finishing ? Promise.resolve() : enqueue(async () => {
              await this.driver.update(update);
              await this.lifecycle.flush?.();
            }),
            finish: outcome => {
              if (finishing) return tail;
              finishing = true;
              return enqueue(async () => {
                await this.driver.finish(outcome);
                if (this.active === active) this.active = null;
              });
            },
          } satisfies AgentAcpProviderTurnSink;
        },
        fail: error => { if (current()) this.driver.fail(error); },
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
    if (!current()) { await source.dispose(); return; }
    this.source = source;
  }
}
