import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const DBW_COMPOSE_CLEANUP_DIR = 'HAPPIER_TEST_DBW_COMPOSE_CLEANUP_DIR';
const docker = promisify(execFile);

export async function readDatabaseWorkbenchComposeResources(project) {
  const filter = `label=com.docker.compose.project=${project}`;
  const commands = [
    ['ps', '--all', '--format', '{{.Names}}'],
    ['network', 'ls', '--format', '{{.Name}}'],
    ['volume', 'ls', '--format', '{{.Name}}'],
  ];
  const [containers, networks, volumes] = await Promise.all(commands.map(async args =>
    (await docker('docker', [...args, '--filter', filter])).stdout.trim().split(/\r?\n/u).filter(Boolean)));
  return { containers, networks, volumes };
}

export async function downDatabaseWorkbenchComposeProject(directory, project) {
  const { containers, networks, volumes } = await readDatabaseWorkbenchComposeResources(project);
  if (!containers.length && !networks.length && !volumes.length) return;

  // The deployment may have released its rendered Compose files already. Down
  // can remove orphan services and the exact project-labeled networks/volumes.
  const file = join(directory, `${project}.json`);
  const inspectNames = (kind, names) => Promise.all(names.map(async name => {
    const { stdout } = await docker('docker', [kind, 'inspect', '--format', `{{index .Labels "com.docker.compose.${kind}"}}`, name]);
    return [stdout.trim(), { name }];
  }));
  const [networkNames, volumeNames] = await Promise.all([
    inspectNames('network', networks),
    inspectNames('volume', volumes),
  ]);
  await writeFile(file, JSON.stringify({
    // Compose otherwise derives an empty model once the orphan containers
    // have been removed. This service exists only to retain the cleanup model.
    services: { fixtureCleanup: {
      image: 'scratch',
      networks: networkNames.map(([key]) => key),
      volumes: volumeNames.map(([key], index) => `${key}:/fixture-volume-${index}`),
    } },
    networks: Object.fromEntries(networkNames),
    volumes: Object.fromEntries(volumeNames),
  }));
  // Disposable fixture data can be removed within the runner's abort grace.
  await docker('docker', ['compose', '-p', project, '-f', file, 'down', '-v', '--remove-orphans', '--timeout', '0']);
  const remaining = await readDatabaseWorkbenchComposeResources(project);
  if ([...remaining.containers, ...remaining.networks, ...remaining.volumes].length) {
    throw new Error(`Compose down left resources for ${project}: ${JSON.stringify(remaining)}`);
  }
}

export async function cleanupRecordedDatabaseWorkbenchProjects(directory) {
  const projects = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const results = await Promise.allSettled(projects.map(project =>
    downDatabaseWorkbenchComposeProject(join(directory, project), project)));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'DBW Compose cleanup failed');
}
