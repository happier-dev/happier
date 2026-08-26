import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
  AgentRuntimeHandoffSurface,
  AgentTerminalSessionStateUpdate,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  CodexSessionHandoffBundleSchema,
  CodexSessionHandoffBundleValidationError,
} from './bundle.js';
import { resolveCodexNativeTranscriptPathCandidate } from '../../../rollout/discovery/nativeSessionLog.js';
import { exportCodexSessionBundle } from './export.js';
import { importCodexSessionBundle } from './import.js';

export const codexHandoffSurface = {
  exportBundle: async (params, context) => {
    const remoteSessionId = params.sessionId.trim() || null;
    if (!remoteSessionId) {
      return { ok: false, code: 'bundle_invalid', message: 'Codex handoff export requires a vendor session id' };
    }
    try {
      const bundle = await exportCodexSessionBundle({
        metadata: params.metadata,
        remoteSessionId,
        env: process.env,
        activeServerDir: params.directory,
        signal: context.signal,
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
  importBundle: async (params, context) => {
    const parsedBundle = CodexSessionHandoffBundleSchema.safeParse(params.bundle);
    if (!parsedBundle.success) {
      return { ok: false, code: 'bundle_invalid', message: `Codex handoff import received unsupported bundle` };
    }
    try {
      const imported = await importCodexSessionBundle({
        bundle: parsedBundle.data,
        targetPath: params.targetDirectory,
        env: process.env,
        signal: context.signal,
      });
      const sessionStateUpdates: AgentTerminalSessionStateUpdate[] = [
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
            ...imported.resume,
            sessionStateUpdates,
          },
        },
      };
    } catch (error) {
      if (error instanceof CodexSessionHandoffBundleValidationError) {
        return {
          ok: false,
          code: 'bundle_invalid',
          message: error.message,
        };
      }
      if (
        isPluginError(error)
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
  resolveNativeTranscriptPathCandidate: async (params) =>
    await resolveCodexNativeTranscriptPathCandidate(params),
} satisfies AgentRuntimeHandoffSurface;
