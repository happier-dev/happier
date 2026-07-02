import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import { readAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import type { TranscriptLookupOutcome, TranscriptMessageLookupResult } from '../transcriptMessageLookup';
import {
  createKeyedSingleFlightScheduler,
  type KeyedSingleFlightScheduler,
} from '../../connection/scheduling/createKeyedSingleFlightScheduler';

export type TranscriptRecoveryDeferredReason =
  | 'supervisor_auth_failed'
  | 'supervisor_offline'
  | 'backoff';

export type TranscriptRecoveryErrorReason =
  | 'auth_failed'
  | 'unhealthy'
  | 'protocol_error';

export type TranscriptRecoveryResult<T> =
  | { type: 'success'; value: T }
  | { type: 'not_found' }
  | { type: 'deferred'; reason: TranscriptRecoveryDeferredReason }
  | { type: 'error'; reason: TranscriptRecoveryErrorReason; error: unknown };

export interface TranscriptRecoveryCoordinatorOptions {
  delayMs?: number;
  maxConcurrent?: number;
  errorBackoffBaseMs?: number;
  errorBackoffMaxMs?: number;
}

export interface TranscriptRecoveryRequest {
  sessionId: string;
  localId: string;
  supervisor: ManagedConnectionSupervisor;
  runRequest: () => Promise<TranscriptLookupOutcome>;
}

type BackoffState = {
  attempt: number;
  retryAt: number;
};

function normalizeDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveMs(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function recoveryKey(sessionId: string, localId: string): string {
  return JSON.stringify([sessionId, localId]);
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return undefined;
}

function reportUnhealthyProbe(
  supervisor: ManagedConnectionSupervisor,
  params: Readonly<{ reason: Extract<TranscriptLookupOutcome, { type: 'unhealthy' }>['reason']; error: unknown }>,
): void {
  supervisor.reportProbeResult?.({
    status: params.reason === 'server_5xx' ? 'retry_later' : 'server_unreachable',
    errorMessage: readErrorMessage(params.error),
  });
}

export class TranscriptRecoveryCoordinator {
  private static instancesByServerUrl = new Map<string, TranscriptRecoveryCoordinator>();

  private readonly scheduler: KeyedSingleFlightScheduler;
  private readonly errorBackoffBaseMs: number;
  private readonly errorBackoffMaxMs: number;
  private readonly backoffByKey = new Map<string, BackoffState>();

  private constructor(options: TranscriptRecoveryCoordinatorOptions = {}) {
    this.scheduler = createKeyedSingleFlightScheduler({
      delayMs: normalizeDelayMs(options.delayMs ?? configuration.transcriptRecoveryDelayMs),
      maxConcurrent: options.maxConcurrent ?? configuration.transcriptRecoveryMaxConcurrent,
    });
    this.errorBackoffBaseMs = normalizePositiveMs(options.errorBackoffBaseMs ?? configuration.transcriptLookupErrorBackoffBaseMs);
    this.errorBackoffMaxMs = Math.max(
      this.errorBackoffBaseMs,
      normalizePositiveMs(options.errorBackoffMaxMs ?? configuration.transcriptLookupErrorBackoffMaxMs),
    );
  }

  public static forServer(serverUrl: string, options?: TranscriptRecoveryCoordinatorOptions): TranscriptRecoveryCoordinator {
    const existing = this.instancesByServerUrl.get(serverUrl);
    if (existing) return existing;
    const instance = new TranscriptRecoveryCoordinator(options);
    this.instancesByServerUrl.set(serverUrl, instance);
    return instance;
  }

  public static __resetForTesting(): void {
    this.instancesByServerUrl.clear();
  }

  public scheduleByLocalId(
    params: TranscriptRecoveryRequest,
  ): Promise<TranscriptRecoveryResult<TranscriptMessageLookupResult>> {
    const key = recoveryKey(params.sessionId, params.localId);
    const supervisorDeferral = this.readSupervisorDeferral(params.supervisor);
    if (supervisorDeferral) return Promise.resolve(supervisorDeferral);
    const backoffDeferral = this.readBackoffDeferral(key);
    if (backoffDeferral) return Promise.resolve(backoffDeferral);

    return this.scheduler.scheduleResult(key, async () => {
      const currentSupervisorDeferral = this.readSupervisorDeferral(params.supervisor);
      if (currentSupervisorDeferral) return currentSupervisorDeferral;
      const currentBackoffDeferral = this.readBackoffDeferral(key);
      if (currentBackoffDeferral) return currentBackoffDeferral;

      try {
        return this.mapLookupOutcome(key, params.supervisor, await params.runRequest());
      } catch (error) {
        return this.mapThrownError(key, params.supervisor, error);
      }
    });
  }

  private readSupervisorDeferral(supervisor: ManagedConnectionSupervisor): TranscriptRecoveryResult<never> | null {
    const state = supervisor.getState();
    if (state.phase === 'auth_failed') return { type: 'deferred', reason: 'supervisor_auth_failed' };
    if (state.phase !== 'online') return { type: 'deferred', reason: 'supervisor_offline' };
    return null;
  }

  private readBackoffDeferral(key: string): TranscriptRecoveryResult<never> | null {
    const state = this.backoffByKey.get(key);
    if (!state) return null;
    if (state.retryAt > Date.now()) return { type: 'deferred', reason: 'backoff' };
    return null;
  }

  private mapLookupOutcome(
    key: string,
    supervisor: ManagedConnectionSupervisor,
    outcome: TranscriptLookupOutcome,
  ): TranscriptRecoveryResult<TranscriptMessageLookupResult> {
    switch (outcome.type) {
      case 'found':
        this.clearBackoff(key);
        return { type: 'success', value: outcome.message };
      case 'not_found':
        this.clearBackoff(key);
        return { type: 'not_found' };
      case 'auth_failed':
        supervisor.reportProbeResult?.({
          status: 'auth_failed',
          statusCode: outcome.statusCode,
          errorMessage: readErrorMessage(outcome.error),
        });
        return { type: 'error', reason: 'auth_failed', error: outcome.error };
      case 'unhealthy':
        reportUnhealthyProbe(supervisor, { reason: outcome.reason, error: outcome.error });
        this.applyBackoff(key);
        return { type: 'error', reason: 'unhealthy', error: outcome.error };
      case 'protocol_error':
        this.applyBackoff(key);
        return { type: 'error', reason: 'protocol_error', error: outcome.error };
    }
  }

  private mapThrownError(
    key: string,
    supervisor: ManagedConnectionSupervisor,
    error: unknown,
  ): TranscriptRecoveryResult<TranscriptMessageLookupResult> {
    const authStatus = readAuthenticationStatus(error);
    if (authStatus !== null) {
      supervisor.reportProbeResult?.({
        status: 'auth_failed',
        statusCode: authStatus,
        errorMessage: readErrorMessage(error),
      });
      return { type: 'error', reason: 'auth_failed', error };
    }

    const statusCode = readHttpStatus(error);
    if (typeof statusCode === 'number' && statusCode >= 500) {
      reportUnhealthyProbe(supervisor, { reason: 'server_5xx', error });
      this.applyBackoff(key);
      return { type: 'error', reason: 'unhealthy', error };
    }

    this.applyBackoff(key);
    return { type: 'error', reason: 'protocol_error', error };
  }

  private clearBackoff(key: string): void {
    this.backoffByKey.delete(key);
  }

  private applyBackoff(key: string): void {
    const existing = this.backoffByKey.get(key);
    const attempt = (existing?.attempt ?? 0) + 1;
    const multiplier = 2 ** Math.max(0, attempt - 1);
    const delayMs = Math.min(this.errorBackoffMaxMs, this.errorBackoffBaseMs * multiplier);
    this.backoffByKey.set(key, {
      attempt,
      retryAt: Date.now() + delayMs,
    });
  }
}
