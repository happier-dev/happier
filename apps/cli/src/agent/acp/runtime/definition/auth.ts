import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import type { AcpRuntimeDefinitionV1 } from './_types';

const MAX_AUTH_META_ERROR_DIAGNOSTIC_CHARS = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeAuthMetaDiagnostic(error: unknown): string {
  const redacted = redactBugReportSensitiveText(errorMessage(error))
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s,;]+)/gi, '$1=<redacted>');
  return redacted.length > MAX_AUTH_META_ERROR_DIAGNOSTIC_CHARS
    ? `${redacted.slice(0, MAX_AUTH_META_ERROR_DIAGNOSTIC_CHARS)}...`
    : redacted;
}

function validateAuthenticateMeta(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  value: unknown;
}>): Readonly<Record<string, unknown>> | undefined {
  if (params.value === null || params.value === undefined) {
    return undefined;
  }
  if (!params.value || typeof params.value !== 'object' || Array.isArray(params.value)) {
    throw new Error(`ACP backend '${params.definition.backendId}' auth.buildAuthenticateMeta callback returned an invalid metadata record.`);
  }
  return Object.freeze({ ...(params.value as Record<string, unknown>) });
}

export function resolveAcpAuthenticateMeta(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  pluginContext?: PluginContextV1;
}>): Readonly<Record<string, unknown>> | undefined {
  const callback = params.definition.auth?.buildAuthenticateMeta;
  if (!callback) {
    return undefined;
  }
  if (!params.pluginContext) {
    throw new Error(
      `ACP backend '${params.definition.backendId}' auth.buildAuthenticateMeta callback requires a plugin runtime context.`,
    );
  }
  try {
    return validateAuthenticateMeta({
      definition: params.definition,
      value: callback(params.pluginContext),
    });
  } catch (error) {
    throw new Error(
      `ACP backend '${params.definition.backendId}' auth.buildAuthenticateMeta callback failed: ${sanitizeAuthMetaDiagnostic(error)}`,
      { cause: error },
    );
  }
}
