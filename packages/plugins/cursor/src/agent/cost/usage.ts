export type CursorUsageState = Readonly<{
  sessionId: string;
  totalUsd: number;
  deltaUsd: number;
}>;

export type CursorUsageObservation = Readonly<{
  sessionId: string;
  totalUsd: number;
}>;

export function applyCursorUsageObservation(
  previous: CursorUsageState | null,
  observation: CursorUsageObservation,
): CursorUsageState {
  const previousTotal = previous?.sessionId === observation.sessionId ? previous.totalUsd : 0;
  const deltaUsd = Math.round(Math.max(0, observation.totalUsd - previousTotal) * 1_000_000) / 1_000_000;
  return {
    sessionId: observation.sessionId,
    totalUsd: observation.totalUsd,
    deltaUsd,
  };
}
