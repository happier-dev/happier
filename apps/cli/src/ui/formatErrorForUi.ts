import { redactBugReportSensitiveText } from '@happier-dev/protocol';

/**
 * Convert an unknown thrown value into a user-visible string.
 *
 * Intended for UI surfaces (TUI/mobile) where giant stacks can be noisy; we keep a generous cap.
 */
export function formatErrorForUi(error: unknown, opts?: { maxChars?: number }): string {
  const maxChars = Math.max(1000, opts?.maxChars ?? 50_000);

  const msg = (() => {
    if (error instanceof Error) {
      return error.stack || error.message || String(error);
    }

    if (typeof error === 'object' && error !== null) {
      const seen = new WeakSet<object>();
      try {
        return JSON.stringify(
          error,
          (_key, value) => {
            if (value instanceof Error) {
              return {
                name: value.name,
                message: value.message,
                stack: value.stack,
              };
            }
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[Circular]';
              seen.add(value);
            }
            return value;
          },
          2,
        );
      } catch {
        return String(error);
      }
    }

    return String(error);
  })();

  const redacted = redactBugReportSensitiveText(msg);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n…[truncated]` : redacted;
}
