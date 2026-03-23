import type { SessionHandoffProviderBundle } from './types';

import { exportClaudeSessionBundle } from '../../backends/claude/handoff/exportClaudeSessionBundle';
import { exportCodexSessionBundle } from '../../backends/codex/handoff/exportCodexSessionBundle';
import { exportOpenCodeSessionBundle } from '../../backends/opencode/handoff/exportOpenCodeSessionBundle';
import { resolveSessionHandoffEligibility } from './resolveSessionHandoffEligibility';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function exportSessionHandoffProviderBundle(params: Readonly<{
  metadata: unknown;
  activeServerDir: string;
}>): Promise<Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  targetPath: string;
}>> {
  const metadata = asRecord(params.metadata);
  if (!metadata) {
    throw new Error('Session metadata is unavailable');
  }

  const eligibility = resolveSessionHandoffEligibility({ metadata });
  if (!eligibility.eligible) {
    throw new Error(`Session is not eligible for handoff: ${eligibility.reasonCode}`);
  }

  const targetPath = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  if (!targetPath) {
    throw new Error('Session path is unavailable for handoff');
  }

  switch (eligibility.agentId) {
    case 'claude':
      return {
        providerBundle: await exportClaudeSessionBundle({
          metadata,
          remoteSessionId: eligibility.vendorHandoffId,
          env: process.env,
        }),
        targetPath,
      };
    case 'codex':
      {
        const bundle = await exportCodexSessionBundle({
          metadata,
          remoteSessionId: eligibility.vendorHandoffId,
          env: process.env,
          activeServerDir: params.activeServerDir,
        });
        return {
          providerBundle: {
            ...bundle,
            files: bundle.files.map((file) => ({ ...file })),
          },
          targetPath,
        };
      }
    case 'opencode':
      return {
        providerBundle: await exportOpenCodeSessionBundle({
          metadata,
          remoteSessionId: eligibility.vendorHandoffId,
        }),
        targetPath,
      };
    default:
      throw new Error(`Unsupported handoff provider: ${eligibility.agentId}`);
  }
}
