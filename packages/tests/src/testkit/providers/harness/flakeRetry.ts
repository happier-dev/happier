export async function runWithFlakeRetry(params: Readonly<{
  enabled: boolean;
  runOnce: (attempt: 1 | 2) => Promise<void>;
  flakyErrorMessage: string;
}>): Promise<void> {
  if (!params.enabled) {
    await params.runOnce(1);
    return;
  }

  try {
    await params.runOnce(1);
  } catch (e1) {
    try {
      await params.runOnce(2);
    } catch {
      throw e1;
    }
    throw new Error(params.flakyErrorMessage);
  }
}

