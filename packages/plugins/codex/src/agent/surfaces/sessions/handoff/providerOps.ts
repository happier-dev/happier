import type { HandoffSurfaceV1, SessionStateUpdateV1 } from '@happier-dev/agents';
import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';

import type { CodexSessionHandoffBundle } from './bundle.js';
import { exportCodexSessionBundle } from './export.js';
import { importCodexSessionBundle } from './import.js';

export const codexHandoffSurface = {
  exportBundle: async (params) => {
    const metadata = params.metadata as Record<string, unknown>;
    const remoteSessionId = resolveVendorResumeIdFromSessionMetadata('codex', metadata);
    if (!remoteSessionId) {
      return { ok: false, code: 'bundle_invalid', message: 'Codex handoff export requires a vendor session id' };
    }
    try {
      const bundle = await exportCodexSessionBundle({
        metadata,
        remoteSessionId,
        env: process.env,
        activeServerDir: params.directory,
      });
      return { ok: true, value: { bundle } };
    } catch (error) {
      return {
        ok: false,
        code: 'handoff_failed',
        message: error instanceof Error ? error.message : 'Codex handoff export failed',
      };
    }
  },
  importBundle: async (params) => {
    const bundle = params.bundle as Partial<CodexSessionHandoffBundle>;
    if (bundle.providerId !== 'codex') {
      return { ok: false, code: 'bundle_invalid', message: `Codex handoff import received unsupported bundle` };
    }
    try {
      const imported = await importCodexSessionBundle({
        bundle: bundle as CodexSessionHandoffBundle,
        targetPath: params.targetDirectory,
        env: process.env,
      });
      const sessionStateUpdates: SessionStateUpdateV1[] = [
        ...(imported.runtimeDescriptorV1
          ? [{
              fieldId: 'identity.runtimeDescriptor' as const,
              value: imported.runtimeDescriptorV1,
            }]
          : []),
        {
          fieldId: 'identity.providerSessionId' as const,
          value: imported.remoteSessionId,
        },
      ];
      return {
        ok: true,
        value: {
          providerSessionId: imported.remoteSessionId,
          source: imported.externalSource,
          launch: {
            directory: imported.resume.directory,
            ...(imported.resume.environmentVariables ? { environmentVariables: imported.resume.environmentVariables } : {}),
            sessionStateUpdates,
          },
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'target_import_failed',
        message: error instanceof Error ? error.message : 'Codex handoff import failed',
      };
    }
  },
} satisfies HandoffSurfaceV1;
