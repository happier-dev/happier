import type {
  TerminalControlCaptureResult,
  TerminalControlPort,
  TerminalControlSendResult,
  TerminalSpecialKey,
  TerminalHostKind,
} from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * TEST-ONLY scripted {@link TerminalControlPort}. Not exported from index.ts and never imported by
 * runtime code. Returns successive screen captures and records every send so controller/control-module
 * tests can assert exact ordering (e.g. that `/permissions` is never sent and ShiftTab is verified).
 */
export type FakeControlPortLogEntry =
  | Readonly<{ type: 'literal'; text: string }>
  | Readonly<{ type: 'raw'; sequence: string }>
  | Readonly<{ type: 'key'; key: TerminalSpecialKey }>
  | Readonly<{ type: 'capture'; index: number }>;

export type FakeControlPort = TerminalControlPort &
  Readonly<{
    log: FakeControlPortLogEntry[];
    sentLiteral: string[];
    sentRaw: string[];
    sentKeys: TerminalSpecialKey[];
    captureCount: () => number;
  }>;

export function createFakeControlPort(params: Readonly<{
  captures: readonly string[];
  hostKind?: TerminalHostKind | undefined;
  hostDead?: boolean | undefined;
  capturedAtMs?: number | undefined;
  /** Keys whose send reports `host_dead` AFTER `onSendSpecialKey` runs (host-race simulation). */
  failSendKeys?: readonly TerminalSpecialKey[] | undefined;
  /** Capture indexes (0-based) that report `host_dead` instead of a screen. */
  failCaptureAtIndexes?: readonly number[] | undefined;
  /** Side-effect hook before a special key resolves (e.g. simulate Claude mutating settings on Enter). */
  onSendSpecialKey?: ((key: TerminalSpecialKey) => Promise<void> | void) | undefined;
  /** Side-effect hook before a literal write resolves. */
  onSendLiteralText?: ((text: string) => Promise<void> | void) | undefined;
}>): FakeControlPort {
  const hostKind: TerminalHostKind = params.hostKind ?? 'tmux';
  const log: FakeControlPortLogEntry[] = [];
  const sentLiteral: string[] = [];
  const sentRaw: string[] = [];
  const sentKeys: TerminalSpecialKey[] = [];
  let captureIndex = 0;

  const ok = (): TerminalControlSendResult => ({ status: 'sent', at: params.capturedAtMs ?? 0 });

  return {
    hostKind,
    log,
    sentLiteral,
    sentRaw,
    sentKeys,
    captureCount: () => captureIndex,
    async sendLiteralText(text) {
      sentLiteral.push(text);
      log.push({ type: 'literal', text });
      await params.onSendLiteralText?.(text);
      return ok();
    },
    async sendRawSequence(sequence) {
      sentRaw.push(sequence);
      log.push({ type: 'raw', sequence });
      return ok();
    },
    async sendSpecialKey(key) {
      sentKeys.push(key);
      log.push({ type: 'key', key });
      await params.onSendSpecialKey?.(key);
      if (params.failSendKeys?.includes(key)) {
        return { status: 'host_dead', recoverable: false };
      }
      return ok();
    },
    async captureScreen(): Promise<TerminalControlCaptureResult> {
      if (params.hostDead) {
        return { status: 'host_dead', recoverable: false };
      }
      if (params.failCaptureAtIndexes?.includes(captureIndex)) {
        log.push({ type: 'capture', index: captureIndex });
        captureIndex += 1;
        return { status: 'host_dead', recoverable: false };
      }
      const idx = Math.min(captureIndex, params.captures.length - 1);
      const text = params.captures.length > 0 ? params.captures[idx] : '';
      log.push({ type: 'capture', index: captureIndex });
      captureIndex += 1;
      return {
        status: 'captured',
        capture: { text, capturedAtMs: params.capturedAtMs ?? 0, hostKind },
      };
    },
  };
}
