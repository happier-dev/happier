/** Pure vocabulary keeps Action identity admission independent of completion/catalog loading. */
export const PROJECT_ACTION_IDS_V1 = [
  'projects.trust.list', 'projects.trust.revoke', 'projects.prepare', 'projects.script.run', 'projects.compute.exec',
] as const;
export type ProjectActionIdV1 = typeof PROJECT_ACTION_IDS_V1[number];
export function isProjectActionIdV1(value: string): value is ProjectActionIdV1 {
  return (PROJECT_ACTION_IDS_V1 as readonly string[]).includes(value);
}
