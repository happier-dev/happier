import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { createAgySubagentSidechainResolver } from './agySubagentSidechains';

const PARENT = 'parent-conversation';
const ALPHA = '84c22f3a-6377-480c-a1e2-3891dbeceaa0';
const BETA = 'a237c998-8bed-48b6-9307-1add5ac1a592';

const launch = (callId: string, role: string) => ({
  callId, toolName: 'SubAgent', sessionId: PARENT,
  input: { Prompt: `Work as ${role}`, Role: role, TypeName: 'self', _acp: { title: 'Run invoke_subagent' } },
});
const subagentCall = (subagentId: string) => ({ callId: `${subagentId}:call_1`, toolName: 'execute', input: {}, sessionId: PARENT });

async function recordSubagent(profile: string, subagentId: string, role: string): Promise<void> {
  const dir = join(profile, 'antigravity-cli', 'brain', PARENT, '.system_generated', 'subagents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${subagentId}.json`), JSON.stringify({ conversationId: subagentId, subagentDescriptor: { typeName: 'self', role } }));
}

describe('Antigravity subagent attribution', () => {
  it('links parallel subagents to their own launch by the role agy recorded, whatever order they report in', async () => {
    await withTempDir('agy-subagents-', async (profile) => {
      const resolve = createAgySubagentSidechainResolver({ processEnv: { GEMINI_HOME: profile } });
      expect(resolve(launch('call_alpha', 'Alpha Runner'))).toBeNull();
      expect(resolve(launch('call_beta', 'Beta Runner'))).toBeNull();
      await recordSubagent(profile, ALPHA, 'Alpha Runner');
      await recordSubagent(profile, BETA, 'Beta Runner');

      expect(resolve(subagentCall(BETA))).toBe('call_beta');
      expect(resolve(subagentCall(ALPHA))).toBe('call_alpha');
      expect(resolve({ ...subagentCall(BETA), callId: `${BETA}:call_2` })).toBe('call_beta');
      expect(resolve({ callId: 'call_main', toolName: 'execute', input: {}, sessionId: PARENT })).toBeNull();
    });
  });

  it('keeps an unattributable subagent in its own thread instead of guessing between launches', async () => {
    await withTempDir('agy-subagents-', async (profile) => {
      const resolve = createAgySubagentSidechainResolver({ processEnv: { GEMINI_HOME: profile } });
      resolve(launch('call_alpha', 'Alpha Runner'));
      resolve(launch('call_beta', 'Beta Runner'));

      expect(resolve(subagentCall(ALPHA))).toBe(ALPHA);
      expect(resolve(subagentCall(BETA))).toBe(BETA);
    });
  });
});
