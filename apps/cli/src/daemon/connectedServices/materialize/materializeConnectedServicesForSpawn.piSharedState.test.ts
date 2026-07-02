import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { formatPiSessionDirectoryForCwd } from '@happier-dev/plugins-pi/agent/sessionFiles';

import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

describe('materializeConnectedServicesForSpawn (PI shared state)', () => {
  it('imports PI session files into the per-cwd agent sessions directory without exporting PI_CODING_AGENT_SESSION_DIR', async () => {
    const now = Date.now();
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-pi-shared-state-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-pi-shared-state-server-'));
    const sourceAgentDir = await mkdtemp(join(tmpdir(), 'happier-pi-shared-state-source-'));
    const sessionDirectory = '/tmp/project';
    const encodedCwdDir = formatPiSessionDirectoryForCwd(sessionDirectory);
    const sourceSessionsDir = join(sourceAgentDir, 'sessions', encodedCwdDir);
    const sessionFileName = '2026-05-27T00-00-00-000Z_pi-session-1.jsonl';
    const sessionFileContent = '{"id":"pi-session-1"}\n';
    const openai = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    try {
      await mkdir(sourceSessionsDir, { recursive: true });
      await writeFile(join(sourceSessionsDir, sessionFileName), sessionFileContent);

      const result = await materializeConnectedServicesForSpawn({
        agentId: 'pi',
        materializationKey: 'session-shared-import',
        activeServerDir,
        baseDir,
        sessionDirectory,
        recordsByServiceId: new Map([['openai', openai]]),
        accountSettings: {
          connectedServicesProviderStateSharingSettingsV1: {
            v: 1,
            defaults: {
              configMode: 'linked',
              stateMode: 'isolated',
            },
            byAgentId: {
              pi: {
                stateMode: 'shared',
              },
            },
            acknowledgedRisksByAgentId: {},
          },
        },
        processEnv: {
          ...process.env,
          PI_CODING_AGENT_DIR: sourceAgentDir,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
      await expect(readFile(
        join(result!.env.PI_CODING_AGENT_DIR, 'sessions', encodedCwdDir, sessionFileName),
        'utf8',
      )).resolves.toBe(sessionFileContent);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceAgentDir, { recursive: true, force: true });
    }
  });
});
