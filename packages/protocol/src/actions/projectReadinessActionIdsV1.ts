export const PROJECT_READINESS_ACTION_IDS_V1 = ['projects.readiness.read'] as const;
export type ProjectReadinessActionIdV1 = typeof PROJECT_READINESS_ACTION_IDS_V1[number];
export function isProjectReadinessActionIdV1(value: string): value is ProjectReadinessActionIdV1 {
  return (PROJECT_READINESS_ACTION_IDS_V1 as readonly string[]).includes(value);
}
