import {
  createAcpRuntime,
  type AcpRuntime,
} from '@/agent/acp/runtime/createAcpRuntime';

type CreateAcpRuntimeParams = Parameters<typeof createAcpRuntime>[0];

/**
 * Test-only runtime constructor for suites whose subject is not identity persistence.
 * Those suites explicitly classify persistence as externally owned; identity-specific
 * suites must call createAcpRuntime directly with the publication owner under test.
 */
export function createTestAcpRuntime(
  params: Omit<CreateAcpRuntimeParams, 'sessionIdentity'>,
): AcpRuntime {
  return createAcpRuntime({
    ...params,
    sessionIdentity: { kind: 'external-owner' },
  });
}
