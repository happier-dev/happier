import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe('workspace replication (legacy surface deletion)', () => {
  it('keeps transferred-bundles handoff legacy surfaces deleted (no undeployed compatibility)', async () => {
    const srcRoot = fileURLToPath(new URL('../..', import.meta.url));

    await expectMissing(join(srcRoot, 'session/handoff/transfer'));
    await expectMissing(join(srcRoot, 'session/handoff/sessionHandoffStoredTransferredState.ts'));
    await expectMissing(join(srcRoot, 'session/handoff/workspace'));
  });

  it('keeps the legacy in-memory workspace export blob-map builder deleted', async () => {
    const srcRoot = fileURLToPath(new URL('../..', import.meta.url));

    await expectMissing(
      join(srcRoot, 'scm/sourceController/workspaceExportPackaging/buildWorkspaceExportArtifactsFromTransferEntries.ts'),
    );
  });
});
