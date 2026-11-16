import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { startGitSmartHttpFixture } from '@/testkit/scm/gitSmartHttpFixture';
import { runAuthenticatedScmRepositoryCommand } from './repositoryTransport';

describe('host authenticated Git transport', () => {
  it('clones binary smart HTTP while no credential crosses the target process boundary', async () => {
    const authorizationHeader = 'Basic private-fixture-header';
    const forge = await startGitSmartHttpFixture({ authorization: authorizationHeader });
    const targetRequests: string[] = [];
    const source = { ...localWorkspaceSource, kind: 'target' as const, id: 'fixture-target',
      nativeHelperPath: resolveProcessCustodySupportExecutable(process.platform) ?? undefined,
      spawn: (request: Parameters<typeof localWorkspaceSource.spawn>[0]) => {
        targetRequests.push(JSON.stringify(request));
        return localWorkspaceSource.spawn(request);
      } };
    try {
      const destination = join(forge.rootDirectory, 'clone');
      const result = await runWithWorkspaceSource(source, () => runAuthenticatedScmRepositoryCommand({
        repositories: [{ url: forge.url, authorizationHeader }],
        command: { bin: 'git', cwd: forge.rootDirectory,
          args: ['clone', '--branch', forge.branch, forge.url, destination] },
      }));
      expect(result.success, result.stderr).toBe(true);
      expect(await readFile(join(destination, 'sentinel.txt'), 'utf8')).toBe('selected branch\n');
      expect(await readFile(join(destination, 'binary.bin'))).toEqual(await readFile(join(forge.sourceRepositoryPath, 'binary.bin')));
      expect(targetRequests.join('\n')).not.toContain(authorizationHeader);
      expect(JSON.stringify(result)).not.toContain(authorizationHeader);
      expect(forge.requests.some(request => request.path.endsWith('/git-upload-pack') && request.status === 200)).toBe(true);
    } finally { await forge.close(); }
  });
});
