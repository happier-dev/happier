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
 * There is no central `switch(agentId)`: the dispatcher resolves the current
 * catalog callback while the host retains roots, traversal, and resolved paths.
 * These cases distinguish registered native correlation from unsupported Agents.
 */

function baseInput(overrides?: Partial<VerifyResumeReachableInput>): VerifyResumeReachableInput {
  return {
    targetMaterializedRoot: '/nonexistent/k4-dispatch-root',
    vendorResumeId: null,
    ...overrides,
  };
}

const providerCases: ReadonlyArray<Readonly<{ agentId: CatalogAgentId; reason: string }>> = [
  { agentId: 'pi', reason: 'pi_session_file_not_found' },
  { agentId: 'codex', reason: 'codex_session_file_not_found' },
  { agentId: 'gemini', reason: 'gemini_session_file_not_found' },
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

  it.each(['auggie', 'claude', 'opencode'] satisfies CatalogAgentId[])(
    'fails closed with the not-implemented reason for %s without a reachability hook',
    async (agentId) => {
    await expect(
      verifyResumeReachabilityByAgent({ agentId, input: baseInput() }),
    ).resolves.toEqual({ ok: false, reason: REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON });
    },
  );
});
