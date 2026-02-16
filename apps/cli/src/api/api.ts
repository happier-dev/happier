import axios from 'axios'
import { z } from 'zod';
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './session/sessionClient';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import { Credentials } from '@/persistence';

import { resolveMachineEncryptionContext, resolveSessionEncryptionContext } from './client/encryptionKey';
import { resolveLoopbackHttpUrl } from './client/loopbackUrl';
import { openSessionDataEncryptionKey } from './client/openSessionDataEncryptionKey';
import {
  shouldReturnMinimalMachineForGetOrCreateMachineError,
  shouldReturnNullForGetOrCreateSessionError,
} from './client/offlineErrors';
import {
  ConnectedServiceIdSchema,
  SealedConnectedServiceCredentialV1Schema,
  SealedConnectedServiceQuotaSnapshotV1Schema,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceId,
  SealedConnectedServiceCredentialV1,
  SealedConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

export class MachineIdConflictError extends Error {
  readonly machineId: string;
  constructor(machineId: string) {
    super(`Machine id conflict: ${machineId} is already registered to a different account on this server`);
    this.name = 'MachineIdConflictError';
    this.machineId = machineId;
  }
}

export class ConnectedServiceCredentialUnsupportedFormatError extends Error {
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;
  constructor(serviceId: ConnectedServiceId, profileId: string) {
    super(`Connected service credential is in an unsupported legacy format (${serviceId}/${profileId}). Reconnect it in Happier.`);
    this.name = 'ConnectedServiceCredentialUnsupportedFormatError';
    this.serviceId = serviceId;
    this.profileId = profileId;
  }
}

export function isMachineIdConflictError(error: unknown): error is MachineIdConflictError {
  // Avoid relying on `instanceof`: bundlers / test runners may load multiple module instances.
  if (!error || typeof error !== 'object') return false;
  const maybe = error as any;
  return maybe.name === 'MachineIdConflictError' && typeof maybe.machineId === 'string' && maybe.machineId.length > 0;
}

function redactUrlForLog(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Best-effort: strip query/hash to avoid leaking secrets in URLs.
    return value.split('?')[0].split('#')[0];
  }
}

function serializeAxiosErrorForLog(error: unknown): Record<string, unknown> {
  if (axios.isAxiosError(error)) {
    return {
      name: error.name,
      message: error.message,
      code: (error as any)?.code,
      status: error.response?.status,
      method: typeof error.config?.method === 'string' ? error.config.method.toUpperCase() : undefined,
      url: redactUrlForLog(error.config?.url),
    };
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { message: String(error) };
}

function resolveServerHttpBaseUrl(): string {
  return resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
}

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.token, resolveServerHttpBaseUrl())
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null
  }): Promise<Session | null> {
    const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveSessionEncryptionContext(this.credential);
    const sessionsUrl = `${resolveServerHttpBaseUrl()}/v1/sessions`;

    const resolvePositiveIntEnv = (raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number => {
      const value = (raw ?? '').trim();
      if (!value) return fallback;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
    };

    const retryMaxAttempts = resolvePositiveIntEnv(process.env.HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS, 10, { min: 1, max: 50 });
    const retryBaseDelayMs = resolvePositiveIntEnv(process.env.HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS, 250, { min: 0, max: 30_000 });
    const retryMaxDelayMs = resolvePositiveIntEnv(process.env.HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS, 2_000, { min: 0, max: 30_000 });

    const sleep = async (ms: number): Promise<void> => {
      if (ms <= 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    };

    // Create session (retry transient 5xx, but do not enter offline mode for 5xx).
    for (let attempt = 1; attempt <= retryMaxAttempts; attempt += 1) {
      try {
        const response = await axios.post<CreateSessionResponse>(
          sessionsUrl,
          {
            tag: opts.tag,
            metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
            agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
            dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
          },
          {
            headers: {
              'Authorization': `Bearer ${this.credential.token}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000 // 1 minute timeout for very bad network connections
          }
        )

        logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
        let raw = response.data.session;

      // Prefer the session's published data key, but keep backward compatibility with
      // older sessions that have no dataEncryptionKey (machineKey-as-session-key fallback).
      let sessionEncryptionKey = encryptionKey;
      if (this.credential.encryption.type === 'dataKey') {
        const serverEncryptedDataKeyRaw = (raw as any).dataEncryptionKey;
        const opened = openSessionDataEncryptionKey({
          credential: this.credential,
          encryptedDataEncryptionKeyBase64: serverEncryptedDataKeyRaw,
        });
        if (typeof serverEncryptedDataKeyRaw === 'string' && serverEncryptedDataKeyRaw.trim().length > 0 && !opened) {
          logger.debug('[API] Failed to open session dataEncryptionKey (dataKey account)', {
            sessionId: raw.id,
          });
          throw new Error('Failed to open session dataEncryptionKey');
        }
        sessionEncryptionKey = opened ?? this.credential.encryption.machineKey;
      }

      let session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decrypt(sessionEncryptionKey, encryptionVariant, decodeBase64(raw.metadata)),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(sessionEncryptionKey, encryptionVariant, decodeBase64(raw.agentState)) : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: sessionEncryptionKey,
        encryptionVariant: encryptionVariant
      }
      return session;
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const isRetryable5xx = typeof status === 'number' && status >= 500 && status < 600;
        if (isRetryable5xx && attempt < retryMaxAttempts) {
          // Do not log raw Axios errors: they can contain bearer tokens or vendor keys.
          logger.debug('[API] [WARN] getOrCreateSession transient server error, retrying:', serializeAxiosErrorForLog(error));
          const delayMs = Math.min(retryMaxDelayMs, retryBaseDelayMs * Math.pow(2, attempt - 1));
          await sleep(delayMs);
          continue;
        }

        // Never log raw Axios errors: they can contain bearer tokens or vendor keys.
        logger.debug('[API] [ERROR] Failed to get or create session:', serializeAxiosErrorForLog(error));

        if (shouldReturnNullForGetOrCreateSessionError(error, { url: sessionsUrl })) {
          return null;
        }

        throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Unreachable (retryMaxAttempts is min 1); keep TS happy.
    return null;
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
    timeoutMs?: number,
  }): Promise<Machine> {
    const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveMachineEncryptionContext(this.credential);
    const machinesUrl = `${resolveServerHttpBaseUrl()}/v1/machines`;

    // Helper to create minimal machine object for offline mode (DRY)
    const createMinimalMachine = (): Machine => ({
      id: opts.machineId,
      encryptionKey: encryptionKey,
      encryptionVariant: encryptionVariant,
      metadata: opts.metadata,
      metadataVersion: 0,
      daemonState: opts.daemonState || null,
      daemonStateVersion: 0,
    });

    // Create machine
    try {
      const timeoutMs =
        typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
          ? Math.floor(opts.timeoutMs)
          : 60_000;
      const response = await axios.post(
        machinesUrl,
        {
          id: opts.machineId,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: timeoutMs
        }
      );


      const raw = response.data.machine;
      logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);

      // Return decrypted machine like we do for sessions
      const machine: Machine = {
        id: raw.id,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant,
        metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState)) : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
      };
      return machine;
    } catch (error) {
      if (
        axios.isAxiosError(error)
        && error.response?.status === 409
        && (error.response.data as any)?.error === 'machine_id_conflict'
      ) {
        throw new MachineIdConflictError(opts.machineId);
      }

      if (shouldReturnMinimalMachineForGetOrCreateMachineError(error, { url: machinesUrl })) {
        return createMinimalMachine();
      }

      // For other errors, rethrow
      throw error;
    }
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session);
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.credential.token, machine);
  }

  push(): PushNotificationClient {
    return this.pushClient;
  }

  /**
   * Register a vendor API token with the server
   * The token is sent as a JSON string - server handles encryption
   */
  async registerVendorToken(vendor: 'openai' | 'anthropic' | 'gemini', apiKey: any): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    try {
      const response = await axios.post(
        `${serverUrl}/v1/connect/${vendor}/register`,
        {
          token: JSON.stringify(apiKey)
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
    } catch (error) {
      // Never log raw Axios errors: they can contain bearer tokens or vendor keys.
      logger.debug(`[API] [ERROR] Failed to register vendor token:`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to register vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register a sealed connected service credential (v2).
   *
   * The server stores the ciphertext as-is and only keeps non-secret metadata for UX.
   */
  async registerConnectedServiceCredentialSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: SealedConnectedServiceCredentialV1;
    metadata?: {
      kind: 'oauth' | 'token';
      providerEmail?: string | null;
      providerAccountId?: string | null;
      expiresAt?: number | null;
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          sealed: params.sealed,
          ...(params.metadata ? { metadata: params.metadata } : {}),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Connected service credential registered`, {
        serviceId: params.serviceId,
        profileId: params.profileId,
      });
    } catch (error) {
      // Never log raw Axios errors: they can contain bearer tokens or provider secrets.
      logger.debug(`[API] [ERROR] Failed to register connected service credential:`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to register connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getConnectedServiceCredentialSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }): Promise<{
    sealed: SealedConnectedServiceCredentialV1;
    metadata: {
      kind: 'oauth' | 'token';
      providerEmail?: string | null;
      providerAccountId?: string | null;
      expiresAt?: number | null;
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.get(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const schema = z.object({
        sealed: SealedConnectedServiceCredentialV1Schema,
        metadata: z.object({
          kind: z.enum(['oauth', 'token']),
          providerEmail: z.string().nullable().optional(),
          providerAccountId: z.string().nullable().optional(),
          expiresAt: z.number().nullable().optional(),
        }),
      });
      const parsed = schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service credential response');
      }
      return parsed.data;
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const code = (() => {
        if (!axios.isAxiosError(error)) return undefined;
        const data = error.response?.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
        const rec = data as Record<string, unknown>;
        return typeof rec.error === 'string' ? rec.error : undefined;
      })();
      if (status === 404) {
        return null;
      }
      if (status === 409 && code === 'connect_credential_unsupported_format') {
        throw new ConnectedServiceCredentialUnsupportedFormatError(params.serviceId, params.profileId);
      }
      logger.debug(`[API] [ERROR] Failed to get connected service credential:`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async listConnectedServiceProfiles(params: {
    serviceId: ConnectedServiceId;
  }): Promise<{
    serviceId: ConnectedServiceId;
    profiles: Array<{
      profileId: string;
      status: 'connected' | 'needs_reauth';
      kind?: 'oauth' | 'token' | null;
      providerEmail?: string | null;
      providerAccountId?: string | null;
      expiresAt?: number | null;
      lastUsedAt?: number | null;
    }>;
  }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const response = await axios.get(
      `${serverUrl}/v2/connect/${serviceId}/profiles`,
      {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const schema = z.object({
      serviceId: ConnectedServiceIdSchema,
      profiles: z.array(
        z.object({
          profileId: z.string().min(1),
          status: z.enum(['connected', 'needs_reauth']),
          kind: z.enum(['oauth', 'token']).nullable().optional(),
          providerEmail: z.string().nullable().optional(),
          providerAccountId: z.string().nullable().optional(),
          expiresAt: z.number().nullable().optional(),
          lastUsedAt: z.number().nullable().optional(),
        }),
      ),
    });
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Invalid connected service profiles response');
    }
    return parsed.data;
  }

  /**
   * Register a sealed connected service quota snapshot (v2).
   *
   * The server stores the ciphertext as-is and only keeps non-secret metadata for UX.
   */
  async registerConnectedServiceQuotaSnapshotSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: SealedConnectedServiceQuotaSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/quotas`,
        {
          sealed: params.sealed,
          metadata: params.metadata,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Connected service quota snapshot registered`, {
        serviceId: params.serviceId,
        profileId: params.profileId,
      });
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register connected service quota snapshot:`, serializeAxiosErrorForLog(error));
      throw new Error(
        `Failed to register connected service quota snapshot: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async getConnectedServiceQuotaSnapshotSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }): Promise<{
    sealed: SealedConnectedServiceQuotaSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.get(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/quotas`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const schema = z.object({
        sealed: SealedConnectedServiceQuotaSnapshotV1Schema,
        metadata: z.object({
          fetchedAt: z.number(),
          staleAfterMs: z.number(),
          status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
          refreshRequestedAt: z.number().optional(),
        }),
      });
      const parsed = schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service quota snapshot response');
      }
      return parsed.data;
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logger.debug(`[API] [ERROR] Failed to get connected service quota snapshot:`, serializeAxiosErrorForLog(error));
      throw new Error(
        `Failed to get connected service quota snapshot: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async acquireConnectedServiceRefreshLease(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    machineId: string;
    leaseMs: number;
  }): Promise<{ acquired: boolean; leaseUntil: number }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);
    const response = await axios.post(
      `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/refresh-lease`,
      { machineId: params.machineId, leaseMs: params.leaseMs },
      {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const schema = z.object({
      acquired: z.boolean(),
      leaseUntil: z.number(),
    });
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Invalid connected service refresh lease response');
    }
    return parsed.data;
  }
}
