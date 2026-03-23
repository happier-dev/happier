export const WORKSPACE_REPLICATION_SCHEMA_VERSION = 1 as const;

export function assertSupportedWorkspaceReplicationSchemaVersion(schemaVersion: number): asserts schemaVersion is 1 {
  if (schemaVersion !== WORKSPACE_REPLICATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported workspace replication schema version: ${schemaVersion}`);
  }
}

export function isSupportedWorkspaceReplicationSchemaVersion(schemaVersion: number): schemaVersion is 1 {
  return schemaVersion === WORKSPACE_REPLICATION_SCHEMA_VERSION;
}
