// @ts-check

/** @param {string} name @param {number} defaultValue */
function readPositiveIntegerEnv(name, defaultValue) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${raw || '<empty>'})`);
  }
  return parsed;
}

// Preserve the established publish-release transfer budget. Its legacy UPLOAD
// variable names already govern both uploads and immutable audit downloads.
export function resolveReleaseAssetTransferPolicy() {
  return {
    retries: readPositiveIntegerEnv('HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRIES', 3),
    retryDelayMs: readPositiveIntegerEnv('HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRY_DELAY_MS', 2_000),
    timeoutMs: readPositiveIntegerEnv('HAPPIER_PIPELINE_GH_RELEASE_TRANSFER_TIMEOUT_MS', 10 * 60_000),
  };
}

/** @param {unknown} error */
export function formatExecError(error) {
  if (error instanceof Error) {
    const stderr = 'stderr' in error ? String(error.stderr ?? '') : '';
    const stdout = 'stdout' in error ? String(error.stdout ?? '') : '';
    return `${stderr}\n${stdout}\n${error.message}`;
  }
  return String(error);
}

/** @param {unknown} error */
export function isTransientReleaseTransferError(error) {
  const raw = formatExecError(error);
  return (
    /release not found/i.test(raw)
    || /404/i.test(raw)
    || /ETIMEDOUT/i.test(raw)
    || /ECONNRESET/i.test(raw)
    || /connection reset by peer/i.test(raw)
    || /socket hang up/i.test(raw)
    || /Service Unavailable/i.test(raw)
    || /\b50[234]\b/.test(raw)
  );
}

/**
 * Retry only read commands, never their caller's upload/publish mutations or
 * integrity checks. Each invocation must replace any incomplete destination.
 * @param {{ name: string; policy?: ReturnType<typeof resolveReleaseAssetTransferPolicy>; download: (timeoutMs: number) => void }} input
 */
export async function downloadReleaseAssetWithRetry({ name, policy = resolveReleaseAssetTransferPolicy(), download }) {
  for (let attempt = 1; attempt <= policy.retries; attempt += 1) {
    try {
      download(policy.timeoutMs);
      return;
    } catch (error) {
      const detail = formatExecError(error);
      // A malformed gh response is safe to re-read, not proof of a corrupt
      // artifact or permission to retry an ambiguous release mutation.
      const authorizationFailure = /\(HTTP (?:401|403)\)|HTTP\/\S+\s+(?:401|403)\b/i.test(detail);
      const retryable = !authorizationFailure && (
        isTransientReleaseTransferError(error) || /unexpected end of JSON input/i.test(detail)
      );
      if (!retryable) throw error;
      if (attempt === policy.retries) {
        throw new Error(`GitHub asset download failed after ${attempt} attempts for ${name}.\n${detail}`, { cause: error });
      }
      console.warn(`[pipeline] GitHub asset download failed; retrying ${name} (${attempt + 1}/${policy.retries}).\n${detail}`);
      await new Promise((resolve) => setTimeout(resolve, policy.retryDelayMs));
    }
  }
}

/** A retried upload whose earlier timed-out attempt already reached GitHub. */
/** @param {unknown} error */
export function isAlreadyUploadedReleaseAssetError(error) {
  return /already exists/i.test(formatExecError(error));
}
