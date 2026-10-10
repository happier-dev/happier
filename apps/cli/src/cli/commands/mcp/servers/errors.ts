
import type { McpServerCatalogRowMutationResponseV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { fail } from '@happier-dev/cli-common/output';

export type McpServersCommandErrorCode = 'invalid_arguments';

export function createMcpServersCommandError(
  code: McpServersCommandErrorCode,
  message: string,
): Error & { code: McpServersCommandErrorCode } {
  const error = new Error(message) as Error & { code: McpServersCommandErrorCode };
  error.code = code;
  return error;
}

export function createInvalidArgumentsError(message: string): Error & { code: 'invalid_arguments' } {
  return createMcpServersCommandError('invalid_arguments', message) as Error & { code: 'invalid_arguments' };
}

/** Report only the canonical row settlement, never the catalog or server rejection details. */
export async function reportMcpServerCatalogMutation(
  mutation: Promise<McpServerCatalogRowMutationResponseV1>,
  input: Readonly<{ kind: string; json: boolean }>,
): Promise<boolean> {
  let code: string;
  let settlement: Readonly<{ status: string; revision?: number }>;
  try {
    const result = await mutation;
    if (result.status === 'updated') return true;
    code = `mcp_catalog_${result.status.replaceAll('-', '_')}`;
    settlement = { status: result.status, ...('revision' in result ? { revision: result.revision } : {}) };
  } catch (error) {
    const causeCode = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (causeCode === 'outcome_unknown') {
      code = 'mcp_catalog_outcome_unknown';
      settlement = { status: 'outcomeUnknown' };
    } else if (typeof causeCode === 'string' && [
      'scope-retired', 'mcp_catalog_unavailable', 'cancelled', 'not_dispatched', 'unauthorized', 'forbidden', 'unsupported',
      'unreachable', 'invalid-reference', 'account-mode-mismatch', 'encryption-material-unavailable',
    ].includes(causeCode)) {
      code = causeCode.startsWith('mcp_catalog_') ? causeCode : `mcp_catalog_${causeCode.replaceAll('-', '_')}`;
      settlement = { status: causeCode };
    } else {
      throw error;
    }
  }
  if (input.json) {
    await printJsonEnvelope({
      ok: false,
      kind: input.kind,
      error: { code, settlement },
    }, { exitCode: 1 });
  } else {
    console.error(fail(`MCP catalog mutation did not settle: ${settlement.status}`));
    process.exitCode = 1;
  }
  return false;
}
