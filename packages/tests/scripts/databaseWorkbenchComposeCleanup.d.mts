export const DBW_COMPOSE_CLEANUP_DIR: 'HAPPIER_TEST_DBW_COMPOSE_CLEANUP_DIR';

export function readDatabaseWorkbenchComposeResources(project: string): Promise<{
  containers: string[];
  networks: string[];
  volumes: string[];
}>;

export function downDatabaseWorkbenchComposeProject(directory: string, project: string): Promise<void>;
export function cleanupRecordedDatabaseWorkbenchProjects(directory: string): Promise<void>;
