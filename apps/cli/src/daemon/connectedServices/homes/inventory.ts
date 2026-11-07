import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONNECTED_SERVICE_GROUPS_HOME_SEGMENT, resolveConnectedServiceHomesDir } from './resolveConnectedServiceHomeDir';

export async function readConnectedServiceHomeDirectoryNames(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Enumerates only selection roots; Agent state beneath a home is never traversed. */
export async function listExistingConnectedServiceHomeSelections(activeServerDir: string): Promise<readonly Readonly<{
  serviceDirectoryName: string;
  kind: 'profile' | 'group';
  selectionId: string;
  directory: string;
}>[]> {
  const homesRoot = resolveConnectedServiceHomesDir(activeServerDir);
  const selections: { serviceDirectoryName: string; kind: 'profile' | 'group'; selectionId: string; directory: string }[] = [];
  for (const serviceDirectoryName of await readConnectedServiceHomeDirectoryNames(homesRoot)) {
    const serviceRoot = join(homesRoot, serviceDirectoryName);
    for (const name of await readConnectedServiceHomeDirectoryNames(serviceRoot)) {
      if (name === CONNECTED_SERVICE_GROUPS_HOME_SEGMENT) {
        const groupsRoot = join(serviceRoot, name);
        for (const selectionId of await readConnectedServiceHomeDirectoryNames(groupsRoot)) {
          selections.push({ serviceDirectoryName, kind: 'group', selectionId, directory: join(groupsRoot, selectionId) });
        }
      } else selections.push({ serviceDirectoryName, kind: 'profile', selectionId: name, directory: join(serviceRoot, name) });
    }
  }
  return selections;
}
