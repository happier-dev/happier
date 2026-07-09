import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';

const getConnectedServicesMaterializerMock = vi.fn();

vi.mock('@/daemon/connectedServices/catalogHooks', () => ({
  getConnectedServicesMaterializer: getConnectedServicesMaterializerMock,
}));

describe('materializeConnectedServicesForSpawn atomicity', () => {
  afterEach(() => {
    vi.doUnmock('@/utils/fs/replaceDirectoryAtomically');
    getConnectedServicesMaterializerMock.mockReset();
    vi.resetModules();
  });

  it('serializes same-root materializations so a later attempt waits for the active attempt', async () => {
    await withTempDir('happier-connected-services-atomicity-', async (baseDir) => {
      await withTempDir('happier-connected-services-atomicity-server-', async (activeServerDir) => {
        let releaseFirst: () => void = () => {
          throw new Error('first materialization did not start');
        };
        const firstStarted = new Promise<void>((resolve) => {
          getConnectedServicesMaterializerMock.mockResolvedValue(async (params: Readonly<{
            rootDir: string;
            processEnv?: NodeJS.ProcessEnv;
          }>) => {
            const label = String(params.processEnv?.MATERIALIZATION_LABEL ?? '');
            await mkdir(params.rootDir, { recursive: true });
            if (label === 'A') {
              resolve();
              await new Promise<void>((release) => {
                releaseFirst = release;
              });
            }
            await writeFile(join(params.rootDir, 'value.txt'), `${label}\n`, 'utf8');
            return {
              env: {
                MATERIALIZED_ROOT: params.rootDir,
                MATERIALIZATION_LABEL: label,
              },
              targetMaterializedRoot: params.rootDir,
              cleanupOnFailure: null,
              cleanupOnExit: null,
            };
          });
        });

        const { materializeConnectedServicesForSpawn } = await import('./materializeConnectedServicesForSpawn');
        const common = {
          agentId: 'codex' as const,
          materializationKey: 'same-session',
          activeServerDir,
          baseDir,
          recordsByServiceId: new Map(),
        };
        const finalRoot = resolveConnectedServiceMaterializedRootDir(common);

        const first = materializeConnectedServicesForSpawn({
          ...common,
          processEnv: { MATERIALIZATION_LABEL: 'A' },
        });
        await firstStarted;

        let secondSettled = false;
        const secondPromise = materializeConnectedServicesForSpawn({
          ...common,
          processEnv: { MATERIALIZATION_LABEL: 'B' },
        }).finally(() => {
          secondSettled = true;
        });

        await Promise.resolve();
        expect(secondSettled).toBe(false);

        releaseFirst();
        await expect(first).resolves.toMatchObject({
          env: expect.objectContaining({
            MATERIALIZATION_LABEL: 'A',
            MATERIALIZED_ROOT: finalRoot,
          }),
        });
        const second = await secondPromise;
        expect(second?.env.MATERIALIZATION_LABEL).toBe('B');
        expect(second?.env.MATERIALIZED_ROOT).toBe(finalRoot);
        await expect(readFile(join(finalRoot, 'value.txt'), 'utf8')).resolves.toBe('B\n');
      });
    });
  });

  it('serializes env-only promotion attempts instead of superseding the active attempt', async () => {
    await withTempDir('happier-connected-services-promotion-race-', async (baseDir) => {
      await withTempDir('happier-connected-services-promotion-race-server-', async (activeServerDir) => {
        const attemptRootByLabel = new Map<string, string>();
        let releaseFirstPromotion: () => void = () => {
          throw new Error('first promotion did not start');
        };
        const firstPromotionRelease = new Promise<void>((resolve) => {
          releaseFirstPromotion = resolve;
        });
        const firstReachedPromotion = new Promise<void>((resolve) => {
          vi.doMock('@/utils/fs/replaceDirectoryAtomically', () => ({
            replaceDirectoryAtomically: async (params: Readonly<{
              stagedDir: string;
              targetDir: string;
              afterPromote?: () => Promise<void> | void;
            }>) => {
              await mkdir(dirname(params.targetDir), { recursive: true });
              if (params.stagedDir === attemptRootByLabel.get('A')) {
                resolve();
                await firstPromotionRelease;
              }
              await rm(params.targetDir, { recursive: true, force: true });
              await rename(params.stagedDir, params.targetDir);
              await params.afterPromote?.();
            },
          }));
        });
        getConnectedServicesMaterializerMock.mockResolvedValue(async (params: Readonly<{
          rootDir: string;
          processEnv?: NodeJS.ProcessEnv;
        }>) => {
          const label = String(params.processEnv?.MATERIALIZATION_LABEL ?? '');
          attemptRootByLabel.set(label, params.rootDir);
          await mkdir(params.rootDir, { recursive: true });
          return {
            env: {
              MATERIALIZATION_LABEL: label,
            },
            targetMaterializedRoot: null,
            cleanupOnFailure: null,
            cleanupOnExit: null,
          };
        });

        const { materializeConnectedServicesForSpawn } = await import('./materializeConnectedServicesForSpawn');
        const common = {
          agentId: 'codex' as const,
          materializationKey: 'same-session-env-only',
          activeServerDir,
          baseDir,
          recordsByServiceId: new Map(),
        };

        const first = materializeConnectedServicesForSpawn({
          ...common,
          processEnv: { MATERIALIZATION_LABEL: 'A' },
        });
        await firstReachedPromotion;

        const second = materializeConnectedServicesForSpawn({
          ...common,
          processEnv: { MATERIALIZATION_LABEL: 'B' },
        });
        releaseFirstPromotion();

        await expect(first).resolves.toMatchObject({
          env: expect.objectContaining({
            MATERIALIZATION_LABEL: 'A',
          }),
        });
        await expect(second).resolves.toMatchObject({
          env: expect.objectContaining({
            MATERIALIZATION_LABEL: 'B',
          }),
        });
      });
    });
  });
});
