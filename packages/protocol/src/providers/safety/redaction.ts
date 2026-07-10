import { isUnsafeTelemetryDataKey } from '../../common/sensitiveKeys.js';
import { redactSensitiveUrlPathSegments } from '../../browser/diagnostics/egress/url.js';
import { normalizeProviderPublicHeaders } from './headers.js';

export function redactProviderUrlForDiagnostics(rawUrl: string): Readonly<{
  origin: string;
  path: string;
  queryKeys: readonly string[];
}> {
  try {
    const parsed = new URL(rawUrl);
    const queryKeys = [...new Set(
      [...parsed.searchParams.keys()].filter((key) => !isUnsafeTelemetryDataKey(key)),
    )].sort();
    return {
      origin: parsed.origin,
      path: redactSensitiveUrlPathSegments(parsed.pathname || '/'),
      queryKeys,
    };
  } catch {
    return { origin: 'unknown:', path: '/', queryKeys: [] };
  }
}

export function redactProviderHeadersForDiagnostics(
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.keys(normalizeProviderPublicHeaders(headers)).sort();
}

export function redactProviderDiagnosticText(
  input: string,
  values: Readonly<{
    secretValues?: readonly string[];
    headerValues?: readonly string[];
    queryValues?: readonly string[];
  }>,
): string {
  const redactedValues = [...new Set([
    ...(values.secretValues ?? []),
    ...(values.headerValues ?? []),
    ...(values.queryValues ?? []),
  ].filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  return redactedValues.reduce(
    (text, value) => text.split(value).join('[REDACTED]'),
    input,
  );
}

export function containsProviderRegisteredSecret(
  input: string,
  registeredSecretValues: readonly string[],
): boolean {
  return registeredSecretValues.some((value) => value.length > 0 && input.includes(value));
}
