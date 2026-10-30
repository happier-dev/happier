import { describe, expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createAcpRequestFailureLogRecord } from '@/agent/acp/withRetry';
import { createAgyAcpBackend } from './backend';

describe('Antigravity ACP authentication setup diagnostics', () => {
  it.each([
    { code: -32000, reason: 'onboarding_failed', authenticationSetupFailure: true },
    { code: -32000, reason: null, authenticationSetupFailure: false },
    { code: -32603, reason: 'onboarding_failed', authenticationSetupFailure: false },
  ])('retains only the fixed setup category for $code/$reason', async scenario => {
    await withTempDir('agy-auth-diagnostic-', async dir => {
      // A synthetic ACP subprocess is the genuine provider/SDK boundary; no credentials are read.
      const script = writeAcpTestAgentScript({ dir, fileName: 'auth-failure.cjs', source: `
        const readline = require('node:readline');
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          const response = request.method === 'initialize'
            ? { result: { protocolVersion: 1 } }
            : { error: { code: ${scenario.code}, message: 'token=provider-secret-value', data: {
                reason: ${JSON.stringify(scenario.reason)}, token: 'provider-secret-value',
                nested: { authorization: 'Bearer nested-secret-value' }
              } } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
        });
      ` });
      const backend = createAgyAcpBackend({ cwd: dir, launch: { command: process.execPath, args: [script] } });
      try {
        const failure = await backend.startSession().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        const record = createAcpRequestFailureLogRecord({ operation: 'NewSession', error: failure });
        expect(record).toEqual({
          operation: 'NewSession', failureKind: 'provider_rejection', requestErrorCode: scenario.code,
          // The visible-reason preview keeps the provider message shape with every credential redacted.
          sanitizedPreview: 'token: [REDACTED]',
          ...(scenario.authenticationSetupFailure ? { authenticationSetupFailure: true } : {}),
        });
        expect((failure as Error & { data?: unknown }).data).toEqual({});
        const safeOutput = JSON.stringify({ record, message: (failure as Error).message, data: (failure as Error & { data?: unknown }).data });
        expect(safeOutput).not.toContain('onboarding_failed');
        expect(safeOutput).not.toContain('provider-secret-value');
        expect(safeOutput).not.toContain('nested-secret-value');
      } finally {
        await backend.dispose();
      }
    });
  });
});
