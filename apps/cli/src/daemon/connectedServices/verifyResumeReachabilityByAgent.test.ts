import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { VerifyResumeReachableInput } from '@/daemon/connectedServices/verifyResumeReachableTypes';
import { REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON } from '@/daemon/connectedServices/verifyResumeReachableTypes';

import {
  verifyResumeReachabilityByAgent,
} from '@/daemon/connectedServices/verifyResumeReachabilityByAgent';

/**
 * Dispatch contract for the provider-agnostic resume-reachability entry point (K4).
 *
 * After the catalog-hook refactor there is no central `switch(agentId)`: the dispatcher resolves the
 * per-provider probe through `AgentCatalogEntry.verifyResumeReachable`. These tests prove the dispatcher routes to the correct provider
 * hook (observed via each provider's distinct fail reason for a deliberately-missing resume
 * reference) and that providers without the hook fail closed with the stable not-implemented reason.
 * They use `vendorResumeId: null` so every provider short-circuits before any filesystem search,
 * keeping the test deterministic and FS-independent.
 */

function baseInput(overrides?: Partial<VerifyResumeReachableInput>): VerifyResumeReachableInput {
  return {
    targetMaterializedRoot: '/nonexistent/k4-dispatch-root',
    targetMaterializedEnv: {},
    vendorResumeId: null,
    cwd: '/tmp/k4-dispatch-project',
    ...overrides,
  };
}

const providerCases: ReadonlyArray<Readonly<{ agentId: CatalogAgentId; reason: string }>> = [
  { agentId: 'pi', reason: 'pi_session_file_not_found' },
  { agentId: 'codex', reason: 'codex_session_file_not_found' },
  { agentId: 'gemini', reason: 'gemini_session_file_not_found' },
  { agentId: 'opencode', reason: 'opencode_state_not_shared' },
  { agentId: 'claude', reason: 'claude_session_not_in_native_store' },
  { agentId: 'ohMyPi', reason: 'ohmypi_session_file_not_found' },
];

describe('verifyResumeReachabilityByAgent dispatch', () => {
  it.each(providerCases)(
    'routes to the $agentId catalog hook and returns its provider-specific reason',
    async ({ agentId, reason }) => {
      await expect(
        verifyResumeReachabilityByAgent({ agentId, input: baseInput() }),
      ).resolves.toEqual({ ok: false, reason });
    },
  );

  it('keeps Claude fail-closed when a materialized target env has no vendor resume id', async () => {
    await expect(
      verifyResumeReachabilityByAgent({
        agentId: 'claude',
        input: baseInput({
          targetMaterializedEnv: { HAPPIER_CONNECTED_SERVICES_LEGACY_CLAUDE_RESTART_SAME_HOME: '1' },
        }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'claude_session_not_in_native_store' });
  });

  it('routes Claude through the materialized target env when a vendor resume id is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-reachability-'));
    const vendorResumeId = 'claude-session-1';
    const resolvedPath = join(root, 'projects', 'workspace', `${vendorResumeId}.jsonl`);
    try {
      await mkdir(join(root, 'projects', 'workspace'), { recursive: true });
      await writeFile(resolvedPath, `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: vendorResumeId,
      })}\n`);

      await expect(
        verifyResumeReachabilityByAgent({
          agentId: 'claude',
          input: baseInput({
            targetMaterializedEnv: { CLAUDE_CONFIG_DIR: root },
            vendorResumeId,
          }),
        }),
      ).resolves.toEqual({ ok: true, resolvedPath });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['auggie'] satisfies CatalogAgentId[])(
    'fails closed with the not-implemented reason for %s without a reachability hook',
    async (agentId) => {
    await expect(
      verifyResumeReachabilityByAgent({ agentId, input: baseInput() }),
    ).resolves.toEqual({ ok: false, reason: REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON });
    },
  );
});
