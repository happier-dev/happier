import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type {
  AgentRuntimeHandoffSurface,
  AgentTerminalSessionStateUpdate,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  CodexSessionHandoffBundleSchema,
  CodexSessionHandoffBundleValidationError,
} from './bundle.js';
import { resolveCodexNativeTranscriptPathCandidate } from '../../../rollout/discovery/nativeSessionLog.js';
import { buildCodexAgentRuntimeDescriptor, readCanonicalCodexAgentRuntimeDescriptorV1, readExactCodexProviderSessionId } from '../../../../protocol/runtimeDescriptorV1.js';
import { resolveConfiguredCodexHomePath } from '../../../rollout/discovery/homeEntries.js';
import { resolveCodexRuntimeHomeEnvironment } from '../../../auth/services/state/sharing/files.js';
import { resolveExistingCodexIndexedRolloutPath } from '../../../auth/services/state/sharing/reconcileResumeRolloutPath.js';
import { exportCodexSessionBundle, resolveCodexSource } from './export.js';
import { importCodexSessionBundle } from './import.js';
import type { CodexExternalSessionSource } from '../external/models.js';

export const codexHandoffSurface = {
  evaluateAvailability: ({ sessionId, metadata }) => {
    if (!readExactCodexProviderSessionId(sessionId)) {
      return { available: false as const, reasonCode: 'missing_metadata' as const };
    }
    const runtimeDescriptorV1 = metadata?.runtimeDescriptorV1;
    if (!runtimeDescriptorV1 || runtimeDescriptorV1.agentId !== 'codex') {
      return { available: false as const, reasonCode: 'missing_metadata' as const };
    }
    const backendMode = runtimeDescriptorV1.agent.backendMode;
    return backendMode === 'acp' || backendMode === 'appServer'
      ? { available: true as const }
      : { available: false as const, reasonCode: 'runtime_mode_unsupported' as const };
  },
  exportBundle: async (params, context) => {
    // Codex minted this id; the bundle must carry its exact bytes.
    const remoteSessionId = readExactCodexProviderSessionId(params.sessionId);
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
  resolveExistingState: async (params, context) => {
    try {
      context.signal.throwIfAborted();
      const providerSessionId = readExactCodexProviderSessionId(params.sessionId);
      const descriptor = readCanonicalCodexAgentRuntimeDescriptorV1(params.metadata.runtimeDescriptorV1);
      if (!providerSessionId || !descriptor?.backendMode) {
        return { ok: false, code: 'bundle_invalid', message: 'Codex existing-state handoff requires native identity and supported runtime metadata' };
      }
      const env = params.environmentVariables === undefined ? process.env : params.environmentVariables;
      const codexHome = resolveConfiguredCodexHomePath(env);
      const homeDir = resolveHomeDirFromEnvironment(env);
      const environmentVariables = resolveCodexRuntimeHomeEnvironment({
        env,
        codexHome,
        cwd: params.targetDirectory,
        expandHomePath: rawPath => expandHomePath(rawPath, homeDir),
      });
      const indexedPath = await resolveExistingCodexIndexedRolloutPath({
        processEnv: environmentVariables,
        cwd: params.targetDirectory,
        vendorResumeId: providerSessionId,
        signal: context.signal,
      });
      context.signal.throwIfAborted();
      if (!indexedPath) {
        return { ok: false, code: 'existing_session_state_unavailable', message: 'Codex native session is unavailable on the target; enable Transfer session data' };
      }
      const affinity: CodexExternalSessionSource = resolveCodexSource(params.metadata) ?? { kind: 'codexHome', home: 'user' };
      const { homePath: _sourceHomePath, ...portableAffinity } = affinity;
      const source: CodexExternalSessionSource = affinity.home === 'connectedService'
        ? portableAffinity
        : { kind: 'codexHome' as const, home: 'user' as const, homePath: codexHome };
      const runtimeDescriptor = buildCodexAgentRuntimeDescriptor({
        backendMode: descriptor.backendMode,
        providerSessionId,
        home: source.home,
        connectedServiceId: source.connectedServiceId,
        connectedServiceProfileId: source.connectedServiceProfileId,
        connectedServiceGroupId: source.connectedServiceGroupId,
        homePath: codexHome,
      });
      const sessionStateUpdates: AgentTerminalSessionStateUpdate[] = [
        { fieldId: 'identity.runtimeDescriptor', value: runtimeDescriptor },
        { fieldId: 'identity.providerSessionId', value: providerSessionId },
      ];
      return {
        ok: true,
        value: {
          providerSessionId,
          source,
          launch: { directory: params.targetDirectory, environmentVariables, sessionStateUpdates },
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'target_import_failed',
        message: error instanceof Error ? error.message : 'Codex existing-state handoff failed',
      };
    }
  },
  resolveNativeTranscriptPathCandidate: async (params) =>
    await resolveCodexNativeTranscriptPathCandidate(params),
} satisfies AgentRuntimeHandoffSurface;
