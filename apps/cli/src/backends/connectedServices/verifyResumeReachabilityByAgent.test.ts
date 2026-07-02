import { describe, expect, it } from 'vitest';

import type { CatalogAgentId } from '@/backends/types';
import type { VerifyResumeReachableInput } from '@/backends/connectedServices/verifyResumeReachableTypes';

import {
  REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON,
  verifyResumeReachabilityByAgent,
} from './verifyResumeReachabilityByAgent';

/**
 * Dispatch contract for the provider-agnostic resume-reachability entry point (K4).
 *
 * After the catalog-hook refactor there is no central `switch(agentId)`: the dispatcher resolves the
 * per-provider probe through `AgentCatalogEntry.verifyResumeReachable`, implemented in each
 * `backends/<provider>/index.ts`. These tests prove the dispatcher routes to the correct provider
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
  { agentId: 'gemini', reason: 'gemini_state_not_shared' },
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

  it('routes Claude through its normalized signature using the materialized target env as process env', async () => {
    // Claude's underlying probe reads the legacy rollback flag from its process env. The dispatcher
    // must hand Claude the materialized target env (not the ambient process env), so setting the flag
    // there flips the result — proving the normalized `{ vendorResumeId, processEnv }` adaptation.
    await expect(
      verifyResumeReachabilityByAgent({
        agentId: 'claude',
        input: baseInput({
          targetMaterializedEnv: { HAPPIER_CONNECTED_SERVICES_LEGACY_CLAUDE_RESTART_SAME_HOME: '1' },
        }),
      }),
    ).resolves.toEqual({ ok: true, resolvedPath: null });
  });

  it('fails closed with the not-implemented reason for a provider without a reachability hook', async () => {
    await expect(
      verifyResumeReachabilityByAgent({ agentId: 'auggie', input: baseInput() }),
    ).resolves.toEqual({ ok: false, reason: REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON });
  });
});
