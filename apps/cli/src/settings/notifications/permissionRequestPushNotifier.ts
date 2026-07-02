import type { AccountSettings } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveAgentRequestKind, type AgentRequestKind } from '@/agent/permissions/requestKind';
import { logger } from '@/ui/logger';
import { setBoundedMap } from '@/utils/collections/lru';

import { summarizeToolInputForNotification } from '@happier-dev/protocol';
import { sendAgentRequestPushNotificationAsync, type PermissionRequestPushSender } from './permissionRequestPush';

type Entry = {
  state: 'idle' | 'sending' | 'retrying' | 'sent';
  kind: AgentRequestKind;
  toolName: string;
  toolDetails: string | null;
  createdAtMs: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export class PermissionRequestPushNotifier {
  private readonly pushSender: PermissionRequestPushSender;
  private readonly getSettings: () => AccountSettings | null;
  private readonly getSettingsSecretsReadKeys: () => ReadonlyArray<Uint8Array | null | undefined>;
  private readonly getSessionTitle: () => string | null;
  private readonly getAgentDisplayName: () => string | null;
  private readonly sessionId: string;
  private readonly logPrefix: string;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxRetryMs: number;
  private readonly maxEntries: number;
  private readonly nowMs: () => number;
  private readonly onNotifiedAt: (permissionId: string, notifiedAtMs: number) => void;

  private readonly entries = new Map<string, Entry>();

  constructor(params: {
    pushSender: PermissionRequestPushSender;
    getSettings: () => AccountSettings | null;
    getSettingsSecretsReadKeys?: () => ReadonlyArray<Uint8Array | null | undefined>;
    getSessionTitle?: () => string | null;
    getAgentDisplayName?: () => string | null;
    sessionId: string;
    logPrefix: string;
    retryDelaysMs?: readonly number[];
    maxRetryMs?: number;
    maxEntries?: number;
    nowMs?: () => number;
    onNotifiedAt?: (permissionId: string, notifiedAtMs: number) => void;
  }) {
    this.pushSender = params.pushSender;
    this.getSettings = params.getSettings;
    this.getSettingsSecretsReadKeys = params.getSettingsSecretsReadKeys ?? (() => []);
    this.getSessionTitle = params.getSessionTitle ?? (() => null);
    this.getAgentDisplayName = params.getAgentDisplayName ?? (() => null);
    this.sessionId = params.sessionId;
    this.logPrefix = params.logPrefix;
    this.retryDelaysMs = params.retryDelaysMs ?? configuration.permissionRequestPushRetryDelaysMs;
    this.maxRetryMs = params.maxRetryMs ?? configuration.permissionRequestPushRetryMaxMs;
    // The notifier needs at least one cache slot to track in-flight send + retries.
    // Clamp to 1 to avoid disabling pushes when configured to 0.
    this.maxEntries = Math.max(1, Math.floor(params.maxEntries ?? configuration.permissionRequestPushDedupeMaxEntries));
    this.nowMs = params.nowMs ?? (() => Date.now());
    this.onNotifiedAt = params.onNotifiedAt ?? (() => {});
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  markCompleted(permissionId: string): void {
    const existing = this.entries.get(permissionId) ?? null;
    if (!existing) return;
    if (existing.timer) clearTimeout(existing.timer);
    this.entries.delete(permissionId);
  }

  markAlreadyNotified(permissionId: string): void {
    const now = this.nowMs();
    const existing = this.entries.get(permissionId) ?? null;
    const next: Entry = existing
      ? { ...existing, state: 'sent', attempts: Math.max(existing.attempts, 1), timer: null }
      : { state: 'sent', kind: 'permission', toolName: 'unknown_tool', toolDetails: null, createdAtMs: now, attempts: 1, timer: null };
    setBoundedMap(this.entries, permissionId, next, this.maxEntries);
  }

  notify(params: { permissionId: string; toolName: string; toolInput?: unknown; requestKind?: AgentRequestKind; createdAtMs?: number }): void {
    const now = this.nowMs();
    const createdAtMs = typeof params.createdAtMs === 'number' ? params.createdAtMs : now;
    const kind = params.requestKind ?? resolveAgentRequestKind(params.toolName);
    const toolDetails = summarizeToolInputForNotification(params.toolName, params.toolInput);

    const existing = this.entries.get(params.permissionId) ?? null;
    if (existing) {
      // Keep the latest tool name for logging/payload readability.
      if (existing.toolName !== params.toolName || existing.kind !== kind || existing.toolDetails !== toolDetails) {
        setBoundedMap(
          this.entries,
          params.permissionId,
          { ...existing, toolName: params.toolName, kind, toolDetails },
          this.maxEntries,
        );
      } else if (this.maxEntries > 0) {
        // Refresh insertion order to avoid stale eviction.
        setBoundedMap(this.entries, params.permissionId, existing, this.maxEntries);
      }

      if (existing.state === 'sent' || existing.state === 'sending' || existing.state === 'retrying') {
        return;
      }
    }

    const base: Entry = existing ?? {
      state: 'idle',
      kind,
      toolName: params.toolName,
      toolDetails,
      createdAtMs,
      attempts: 0,
      timer: null,
    };
    setBoundedMap(this.entries, params.permissionId, base, this.maxEntries);
    void this.trySendNow(params.permissionId).catch(() => {});
  }

  private resolveNextRetryDelayMs(attemptsAfterFailure: number): number | null {
    const idx = Math.max(0, attemptsAfterFailure - 1);
    const delay = this.retryDelaysMs[idx];
    if (typeof delay !== 'number') return null;
    return Math.max(0, Math.floor(delay));
  }

  private async trySendNow(permissionId: string): Promise<void> {
    const entry = this.entries.get(permissionId) ?? null;
    if (!entry) return;
    if (entry.state === 'sent' || entry.state === 'sending') return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    const now = this.nowMs();
    const ageMs = now - entry.createdAtMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) return;
    if (ageMs > this.maxRetryMs) {
      this.entries.delete(permissionId);
      return;
    }

    const settings = this.getSettings();
    const nextEntry: Entry = { ...entry, state: 'sending', attempts: entry.attempts + 1, timer: null };
    setBoundedMap(this.entries, permissionId, nextEntry, this.maxEntries);
    const result = await sendAgentRequestPushNotificationAsync({
      pushSender: this.pushSender,
      sessionId: this.sessionId,
      sessionTitle: this.readSessionTitle(),
      agentDisplayName: this.readAgentDisplayName(),
      requestId: permissionId,
      toolName: entry.toolName,
      kind: entry.kind,
      settings,
      settingsSecretsReadKeys: this.getSettingsSecretsReadKeys(),
      toolDetails: entry.toolDetails,
    });

    const after = this.entries.get(permissionId) ?? null;
    if (!after) return;

    if (result.status === 'delivered') {
      setBoundedMap(this.entries, permissionId, { ...after, state: 'sent', timer: null }, this.maxEntries);
      try {
        this.onNotifiedAt(permissionId, now);
      } catch {
        // ignore
      }
      return;
    }

    if (result.status === 'skipped') {
      setBoundedMap(this.entries, permissionId, { ...after, state: 'idle', timer: null }, this.maxEntries);
      return;
    }

    const retryDelayMs = this.resolveNextRetryDelayMs(after.attempts);
    if (retryDelayMs === null) {
      // Give up; keep a bounded record to avoid immediate spam if the same pending publish repeats.
      setBoundedMap(this.entries, permissionId, { ...after, state: 'idle', timer: null }, this.maxEntries);
      return;
    }

    const timer = setTimeout(() => {
      void this.trySendNow(permissionId).catch(() => {});
    }, retryDelayMs);
    timer.unref?.();
    setBoundedMap(this.entries, permissionId, { ...after, state: 'retrying', timer }, this.maxEntries);

    logger.debug(`${this.logPrefix} Scheduling request push retry`, {
      permissionId,
      kind: entry.kind,
      attempt: after.attempts,
      retryDelayMs,
    });
  }

  private readSessionTitle(): string | null {
    try {
      return this.getSessionTitle();
    } catch {
      return null;
    }
  }

  private readAgentDisplayName(): string | null {
    try {
      return this.getAgentDisplayName();
    } catch {
      return null;
    }
  }
}
