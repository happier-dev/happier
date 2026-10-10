export const ARTIFACT_FOLDER_ACTION_IDS_V1 = [
  'artifact.folders.list', 'artifact.folders.read',
  'artifact.folders.create', 'artifact.folders.rename', 'artifact.folders.move', 'artifact.folders.delete', 'artifact.folder.set',
] as const;
export type ArtifactFolderActionIdV1 = typeof ARTIFACT_FOLDER_ACTION_IDS_V1[number];
export function isArtifactFolderActionIdV1(value: string): value is ArtifactFolderActionIdV1 {
  return (ARTIFACT_FOLDER_ACTION_IDS_V1 as readonly string[]).includes(value);
}
