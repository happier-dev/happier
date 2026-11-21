import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { prepareManagedForkDirectory } from './prepareManagedForkDirectory';

// Configuration and the file logger are OS boundaries; directory ownership stays real.
vi.mock('@/configuration', () => ({
  configuration: { activeServerDir: '/unused' },
}));
vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));

let disposeNative: (() => Promise<void>) | undefined;
beforeAll(async () => {
  disposeNative = await createProcessCustodyFixture();
});
afterAll(async () => {
  await disposeNative?.();
});

const conflict =
  'Session creation correspondence conflicts with the existing Session';

describe('prepareManagedForkDirectory', () => {
  it('gives a managed Fork child its own birth correspondence, which the daemon admits for the committed child', async () => {
    const parentTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'test',
      creationKey: 'managed-parent',
    });
    const prepared = prepareManagedForkDirectory({
      parentSessionId: 'parent-session',
      parentMetadata: {
        machineId: 'machine-1',
        sessionDirectoryV1: { v: 1, kind: 'managed' },
        sessionCreationCorrespondenceV1: buildSessionCreationCorrespondence({
          identity: { sessionCreationTag: parentTag },
          recipe: {
            execution: {
              machineId: 'machine-1',
              directory: { kind: 'managed' },
            },
            organization: { folderId: 'parent-folder', tagIds: [] },
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            approvalProfileId: 'parent-approval-profile',
            approvalProfileTeamOrGroupDerived: false,
          },
        }),
      },
      directory: '/private/parent-allocation',
      spawnNonce: 'fork-managed',
    });
    if (!prepared)
      throw new Error('A managed parent must yield a managed Fork child');
    const childTag = prepared.sessionCreationTag;
    expect(childTag).not.toBe(parentTag);
    expect(prepared.managedDirectorySeed).toEqual({
      sourceSessionId: 'parent-session',
      sourcePath: '/private/parent-allocation',
      sourceSessionCreationTag: parentTag,
    });
    // The committed child row stores this correspondence; the daemon reads the
    // tag back from it before attaching the child's managed allocation.
    const correspondence = prepared.sessionCreationCorrespondence;
    expect(correspondence?.sessionCreationTag).toBe(childTag);
    // A new birth: none of the parent's placement, approval profile or guest checkout.
    expect(correspondence?.recipe).toMatchObject({
      execution: { machineId: 'machine-1', directory: { kind: 'managed' } },
      organization: { folderId: null, tagIds: [] },
    });
    expect(correspondence?.recipe).not.toHaveProperty('approvalProfileId');
    expect(correspondence?.recipe).not.toHaveProperty('inPlaceWorkspace');

    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-fork-managed-'),
    );
    try {
      const owner = createManagedSessionDirectories({ activeServerDir });
      await expect(
        owner.prepareForSpawn({
          directory: prepared.directory,
          sessionCreationTag: childTag,
          existingSessionId: 'child-session',
          existingSessionCreationTag: correspondence?.sessionCreationTag,
          freshSessionCreation: true,
          approvedNewDirectoryCreation: true,
        }),
      ).resolves.toMatchObject({ ok: true, created: true });
      // Control: a committed row born from another creation, or carrying no birth record, stays refused.
      const other = deriveSessionCreationTagV1({
        callerCreationNamespace: 'test',
        creationKey: 'other-creation',
      });
      await expect(
        owner.prepareForSpawn({
          directory: '/private/other',
          sessionCreationTag: other,
          existingSessionId: 'other-session',
          existingSessionCreationTag: childTag,
          freshSessionCreation: true,
        }),
      ).rejects.toThrow(conflict);
      await expect(
        owner.prepareForSpawn({
          directory: '/private/other',
          sessionCreationTag: other,
          existingSessionId: 'other-session',
          freshSessionCreation: true,
        }),
      ).rejects.toThrow(conflict);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
