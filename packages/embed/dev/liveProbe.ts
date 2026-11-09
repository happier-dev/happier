type ModelProbeClient = Readonly<{
  actions: Readonly<{
    session: Readonly<{
      model: Readonly<{
        set: (
          input: Readonly<{ sessionId: string; modelId: string }>,
          options?: Readonly<{ target: Readonly<{ kind: 'session'; sessionId: string }> }>,
        ) => Promise<unknown>;
      }>;
    }>;
  }>;
}>;

export function readTypedErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown_error';
  const record = error as Readonly<Record<string, unknown>>;
  if (typeof record.code === 'string' && record.code.trim()) return record.code;
  const result = record.result;
  if (result && typeof result === 'object' && typeof (result as Readonly<Record<string, unknown>>).code === 'string') {
    return (result as Readonly<{ code: string }>).code;
  }
  return 'unknown_error';
}

export async function runDeniedModelProbe(client: ModelProbeClient, sessionId: string): Promise<string> {
  try {
    await client.actions.session.model.set(
      { sessionId, modelId: 'fixture-not-granted-model' },
      { target: { kind: 'session', sessionId } },
    );
    return 'unexpected_success';
  } catch (error) {
    return readTypedErrorCode(error);
  }
}
