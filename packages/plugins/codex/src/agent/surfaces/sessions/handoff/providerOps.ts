import { PluginError } from '@happier-dev/plugin-sdk';
import type { HandoffSurfaceV1, SessionStateUpdateV1 } from '@happier-dev/plugin-sdk/experimental/sessions';
import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/plugin-sdk/experimental/sessions';

import { CodexSessionHandoffBundleSchema } from './bundle.js';
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
    const parsedBundle = CodexSessionHandoffBundleSchema.safeParse(params.bundle);
    if (!parsedBundle.success) {
      return { ok: false, code: 'bundle_invalid', message: `Codex handoff import received unsupported bundle` };
    }
    try {
      const imported = await importCodexSessionBundle({
        bundle: parsedBundle.data,
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
            ...(imported.resume.codexBackendMode
              ? { resumePlanOptions: { codexBackendMode: imported.resume.codexBackendMode } }
              : {}),
            ...(imported.resume.environmentVariables ? { environmentVariables: imported.resume.environmentVariables } : {}),
            sessionStateUpdates,
          },
        },
      };
    } catch (error) {
      if (
        error instanceof PluginError
        && (error.code === 'target_identity_conflict' || error.code === 'agent_version_unsupported')
      ) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
      }
      return {
        ok: false,
        code: 'target_import_failed',
        message: error instanceof Error ? error.message : 'Codex handoff import failed',
      };
    }
  },
} satisfies HandoffSurfaceV1;
