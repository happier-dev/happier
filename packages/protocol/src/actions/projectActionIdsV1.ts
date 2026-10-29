/** Pure vocabulary keeps Action identity admission independent of completion/catalog loading. */
export const PROJECT_ACTION_IDS_V1 = [
  'projects.pages.list',
  'projects.trust.list', 'projects.trust.revoke', 'projects.prepare', 'projects.script.run', 'projects.compute.exec',
] as const;
export type ProjectActionIdV1 = typeof PROJECT_ACTION_IDS_V1[number];
export function isProjectActionIdV1(value: string): value is ProjectActionIdV1 {
  return (PROJECT_ACTION_IDS_V1 as readonly string[]).includes(value);
}

/** Invocation roots allowed to prepare their Project's linked worker copy.
 * This classifies the purpose only; each receiver still verifies its signed
 * root, requester custody, original input and current source/target refs.
 */
export function isProjectWorkspaceSyncPreparationActionV1(value: string | undefined): value is
  'projects.script.run' | 'projects.compute.exec' | 'projects.service.relocate' | 'localServices.launcher.start' {
  return value === 'projects.script.run' || value === 'projects.compute.exec'
    || value === 'projects.service.relocate' || value === 'localServices.launcher.start';
}
