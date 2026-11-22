import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceUxDiagnosticCodeV1Schema,
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
  type ConnectedServiceUxDiagnosticV1,
  type SpawnSessionResult,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialize/providerMaterializerTypes';
import { buildConnectedServiceUxDiagnostic } from './connectedServiceUxDiagnostics';

type ConnectedServiceCredentialRefreshSpawnError = Readonly<{
  name?: unknown;
  kind?: unknown;
  serviceId?: unknown;
  profileId?: unknown;
  diagnostic?: unknown;
}>;

type ConnectedServiceCredentialMissingSpawnError = Readonly<{
  name?: unknown;
  kind?: unknown;
  serviceId?: unknown;
  profileId?: unknown;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringField(record: Record<string, unknown> | null, key: string): string {
  return record ? readString(record[key]) : '';
}

function readCredentialRefreshSpawnError(error: unknown): ConnectedServiceCredentialRefreshSpawnError | null {
  const record = readRecord(error);
  if (!record) return null;
  if (readString(record.name) !== 'ConnectedServiceSpawnCredentialRefreshError') return null;
  if (readString(record.kind) !== 'reconnect_required') return null;
  return record;
}

function readCredentialMissingSpawnError(error: unknown): ConnectedServiceCredentialMissingSpawnError | null {
  const record = readRecord(error);
  if (!record) return null;
  if (readString(record.name) !== 'ConnectedServiceCredentialResolutionError') return null;
  if (readString(record.kind) !== 'missing_credential') return null;
  const serviceId = readString(record.serviceId);
  const profileId = readString(record.profileId);
  if (!serviceId || !profileId) return null;
  return record;
}

export function buildConnectedServiceDiagnosticSpawnValidationErrorResult(input: Readonly<{
  errorMessage: string;
  uxDiagnostic: ConnectedServiceUxDiagnosticV1;
}>): Extract<SpawnSessionResult, { type: 'error' }> {
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    errorMessage: input.errorMessage,
    errorDetail: {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      uxDiagnostic: input.uxDiagnostic,
    },
  };
}

export function buildConnectedServiceCredentialSpawnErrorResult(input: Readonly<{
  agentId: CatalogAgentId;
  error: unknown;
}>): Extract<SpawnSessionResult, { type: 'error' }> | null {
  const missingCredential = readCredentialMissingSpawnError(input.error);
  if (missingCredential) {
    const code = CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
    return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
      errorMessage: code,
      uxDiagnostic: buildConnectedServiceUxDiagnostic({
        code,
        failurePhase: 'materialization',
        source: 'spawn_resume',
        agentId: input.agentId,
        serviceId: readString(missingCredential.serviceId),
        profileId: readString(missingCredential.profileId),
        retryable: false,
        diagnostics: {
          reason: 'missing_credential',
        },
      }),
    });
  }

  return buildConnectedServiceCredentialRefreshSpawnErrorResult(input);
}

export function buildConnectedServiceCredentialRefreshSpawnErrorResult(input: Readonly<{
  agentId: CatalogAgentId;
  error: unknown;
}>): Extract<SpawnSessionResult, { type: 'error' }> | null {
  const error = readCredentialRefreshSpawnError(input.error);
  if (!error) return null;

  const diagnostic = readRecord(error.diagnostic);
  const serviceId = readString(error.serviceId) || readStringField(diagnostic, 'serviceId');
  const profileId = readString(error.profileId) || readStringField(diagnostic, 'profileId');
  const reason = readStringField(diagnostic, 'reason') || 'spawn_preflight';
  const refreshStatus = readStringField(diagnostic, 'status') || null;
  const refreshCategory = readStringField(diagnostic, 'category') || null;
  const code = CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;

  return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
    errorMessage: code,
    uxDiagnostic: buildConnectedServiceUxDiagnostic({
      code,
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: input.agentId,
      ...(serviceId ? { serviceId } : {}),
      ...(profileId ? { profileId } : {}),
      retryable: false,
      diagnostics: {
        reason,
        refreshStatus,
        refreshCategory,
      },
    }),
  });
}

/**
 * The identifying fields of a connected-service spawn failure, for the daemon log. The result's
 * message is only the generic code, so without these a refusal caused by one account among several
 * cannot be traced to it. Ids and reasons only; never credential material.
 */
export function readConnectedServiceSpawnFailureLogFields(
  result: Extract<SpawnSessionResult, { type: 'error' }>,
): Readonly<Record<string, string | null>> {
  if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) return {};
  const diagnostic = result.errorDetail.uxDiagnostic;
  const details = readRecord(diagnostic.diagnostics);
  return {
    serviceId: readString(diagnostic.serviceId) || null,
    profileId: readString(diagnostic.profileId) || null,
    reason: readStringField(details, 'reason') || null,
    refreshStatus: readStringField(details, 'refreshStatus') || null,
    refreshCategory: readStringField(details, 'refreshCategory') || null,
  };
}

export function buildConnectedServiceMaterializationSpawnErrorResult(input: Readonly<{
  agentId: CatalogAgentId;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
}>): Extract<SpawnSessionResult, { type: 'error' }> {
  const primary = input.diagnostics[0] ?? null;
  const parsedCode = ConnectedServiceUxDiagnosticCodeV1Schema.safeParse(primary?.code);
  const code = parsedCode.success
    ? parsedCode.data
    : CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed;
  return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
    errorMessage: code,
    uxDiagnostic: buildConnectedServiceUxDiagnostic({
      code,
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: input.agentId,
      ...(primary?.providerId ? { providerId: primary.providerId } : {}),
      ...(primary?.serviceId ? { serviceId: primary.serviceId } : {}),
      retryable: false,
      diagnostics: {
        reason: primary?.reason ?? null,
        materializationCode: primary?.code ?? null,
        entryName: primary?.entryName ?? null,
      },
    }),
  });
}
