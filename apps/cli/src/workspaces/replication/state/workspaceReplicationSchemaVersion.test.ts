import { describe, expect, it } from 'vitest';

describe('workspaceReplicationSchemaVersion', () => {
    it('exposes the supported schema version and rejects unsupported versions', async () => {
        const {
            assertSupportedWorkspaceReplicationSchemaVersion,
            WORKSPACE_REPLICATION_SCHEMA_VERSION,
        } = await import('./workspaceReplicationSchemaVersion');

        expect(WORKSPACE_REPLICATION_SCHEMA_VERSION).toBe(1);
        expect(() => assertSupportedWorkspaceReplicationSchemaVersion(1)).not.toThrow();
        expect(() => assertSupportedWorkspaceReplicationSchemaVersion(2)).toThrow('Unsupported workspace replication schema version: 2');
    });
});
