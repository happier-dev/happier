const CLIENT_CLEANUP_GRACE_MS = 1_000;

export async function waitForClientCleanupGrace(cleanup: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLIENT_CLEANUP_GRACE_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
