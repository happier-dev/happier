import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import type { NormalizedException } from '../otlp/types.js';

/**
 * The top frame without line/column, so a redeploy that only moves code does
 * not split the group. V8/Java `at …`, Firefox/Safari `fn@url` and Python
 * tracebacks (most recent call last) are recognized; anything else has none.
 */
export function exceptionTopFrame(
  stacktrace: string | undefined,
): string | undefined {
  if (!stacktrace) return undefined;
  const lines = stacktrace.split(/\r?\n/u);
  const python = lines.filter((line) => /^\s*File "/u.test(line)).at(-1);
  if (python) {
    const match = /^\s*File "([^"]+)", line \d+(?:, in (.+))?$/u.exec(
      python.trimEnd(),
    );
    if (match) return match[2] ? `${match[2].trim()} (${match[1]})` : match[1];
  }
  for (const line of lines) {
    const at = /^\s*at\s+(.+?)\s*$/u.exec(line);
    if (at) return stripPosition(at[1]!);
    const gecko = /^([^@\s]*)@(.+)$/u.exec(line.trim());
    if (gecko)
      return gecko[1]
        ? `${gecko[1]} (${stripPosition(gecko[2]!)})`
        : stripPosition(gecko[2]!);
  }
  return undefined;
}

function stripPosition(frame: string): string {
  return frame.replace(/:\d+(?::\d+)?(?=\)?$)/u, '');
}

/** Variable parts of an already redacted message; the shape groups, values do not. */
export function normalizeExceptionMessage(message: string | undefined): string {
  return (message ?? '')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
      '<uuid>',
    )
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/giu, '<hex>')
    .replace(/\d+(?:\.\d+)?/gu, '<n>')
    .trim();
}

/**
 * Source-owned grouping, scoped to one Environment partition and service. A
 * supplied fingerprint wins; otherwise type + normalized message + top frame.
 * Version is a cohort, never part of the key.
 */
export function exceptionFingerprint(
  input: Readonly<{
    partition: string;
    serviceName?: string;
    exception: NormalizedException;
  }>,
): string {
  const scope = [input.partition, input.serviceName ?? ''];
  return input.exception.fingerprint !== undefined
    ? computeCanonicalDomainSeparatedDigest(
        'happier.telemetry.exception-group.explicit.v1',
        [...scope, input.exception.fingerprint],
      )
    : computeCanonicalDomainSeparatedDigest(
        'happier.telemetry.exception-group.v1',
        [
          ...scope,
          input.exception.type ?? '',
          normalizeExceptionMessage(input.exception.message),
          exceptionTopFrame(input.exception.stacktrace) ?? '',
        ],
      );
}
