import type {
  PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';
import {
  type AgentRuntimeHandoffSurface,
  type AgentTerminalSessionStateUpdate,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  readOpenCodeProviderSessionIdFromMetadata,
} from '../../../identity/session.js';
import {
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
  type OpenCodeSessionAffinity,
} from '../../../identity/affinity.js';
import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../../../systemTool.js';
import type { OpenCodeExternalSessionSource } from '../external/client.js';
import { normalizeOpenCodeSessionExportForHandoffComparison } from './exportRecords.js';

const OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES = 8 * 1024 * 1024;
const OPEN_CODE_EXPORT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type OpenCodeSessionBundle = Readonly<{
  agentId: 'opencode';
  remoteSessionId: string;
  exportJsonBase64: string;
  affinity: OpenCodeSessionAffinity;
}>;

function estimateBase64DecodedBytes(value: string): number {
  const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - paddingBytes;
}

function decodeOpenCodeImportExportJson(exportJsonBase64: string): string {
  if (!BASE64_PATTERN.test(exportJsonBase64)) {
    throw new Error('Invalid OpenCode handoff export payload encoding');
  }

  const decoded = Buffer.from(exportJsonBase64, 'base64').toString('utf8');
  try {
    JSON.parse(decoded);
  } catch {
    throw new Error('Invalid OpenCode handoff export payload JSON');
  }
  return decoded;
}

function isOpenCodeMissingSessionExport(
  stderr: string,
  providerSessionId: string,
): boolean {
  // OpenCode v1.14.41 at 8ba2a9171597262df9d19516c82a5e14f18f5c63 emits this
  // exact marker from its export command when the native session is absent.
  return stderr.includes(`Session not found: ${providerSessionId}`);
}

function sessionStateUpdatesForImportedSession(params: Readonly<{
  providerSessionId: string;
  backendMode: 'server';
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): AgentTerminalSessionStateUpdate[] {
  const runtimeDescriptor = buildOpenCodeAgentRuntimeDescriptorV1({
    backendMode: params.backendMode,
    providerSessionId: params.providerSessionId,
    ...(params.serverBaseUrl ? { serverBaseUrl: params.serverBaseUrl } : {}),
    ...(params.serverBaseUrl && params.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
  });

  return [
    {
      fieldId: 'identity.runtimeDescriptor',
      value: runtimeDescriptor,
    },
    {
      fieldId: 'identity.providerSessionId',
      value: params.providerSessionId,
    },
  ];
}

function importedSessionResult(params: Readonly<{
  providerSessionId: string;
  targetDirectory: string;
  affinity: OpenCodeSessionAffinity;
}>) {
  const backendMode = 'server';
  const serverBaseUrl = params.affinity.serverBaseUrlExplicit ? params.affinity.serverBaseUrl : null;
  const source: OpenCodeExternalSessionSource = {
    kind: 'opencodeServer',
    ...(serverBaseUrl ? { baseUrl: serverBaseUrl } : {}),
    directory: params.targetDirectory,
  };

  return {
    ok: true,
    value: {
      providerSessionId: params.providerSessionId,
      source,
      launch: {
        directory: params.targetDirectory,
        environmentVariables: buildOpenCodeSessionEnvironmentVariables({
          backendMode,
          serverBaseUrl,
          serverBaseUrlExplicit: params.affinity.serverBaseUrlExplicit,
        }),
        sessionStateUpdates: sessionStateUpdatesForImportedSession({
          providerSessionId: params.providerSessionId,
          backendMode,
          ...(serverBaseUrl ? { serverBaseUrl } : {}),
          serverBaseUrlExplicit: params.affinity.serverBaseUrlExplicit,
        }),
      },
    },
  } as const;
}

function readProcessResult(result: PluginProcessResult): Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return {
    exitCode: result.termination.observed.kind === 'exit'
      ? result.termination.observed.exitCode
      : null,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

async function resolveOpenCodeExecutable(
  exec: import('@happier-dev/plugin-sdk/exec').ExecService,
  purpose: string,
) {
  return (await exec.systemTools.resolve({
    toolId: OPEN_CODE_SYSTEM_TOOL_ID,
    purpose,
  })).executable;
}

export const openCodeHandoffSurface = {
    exportBundle: async (params, context) => {
      const exec = context.services.exec;
      const providerSessionId = readOpenCodeProviderSessionIdFromMetadata(params.metadata);
      if (!providerSessionId) {
        return {
          ok: false,
          code: 'bundle_invalid',
          message: 'OpenCode handoff export requires a provider session id',
        };
      }

      try {
        const executable = await resolveOpenCodeExecutable(exec, 'Export an OpenCode session for handoff');
        const result = readProcessResult(await exec.run(
          {
            executable,
            args: ['export', providerSessionId],
            maxStdoutBytes: OPEN_CODE_EXPORT_MAX_BUFFER_BYTES,
          },
          { signal: context.signal },
        ));
        if (result.exitCode !== 0) {
          return {
            ok: false,
            code: 'handoff_failed',
            message: result.stderr.trim() || 'OpenCode handoff export failed',
          };
        }
        if (Buffer.byteLength(result.stdout, 'utf8') > OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES) {
          throw new Error(`OpenCode handoff export payload exceeds size limit (${OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES} bytes)`);
        }

        const bundle: OpenCodeSessionBundle = {
          agentId: 'opencode',
          remoteSessionId: providerSessionId,
          exportJsonBase64: Buffer.from(result.stdout, 'utf8').toString('base64'),
          affinity: readOpenCodeSessionAffinityFromMetadata(params.metadata),
        };
        return { ok: true, value: { bundle } };
      } catch (error) {
        return {
          ok: false,
          code: 'handoff_failed',
          message: error instanceof Error ? error.message : 'OpenCode handoff export failed',
        };
      }
    },
    importBundle: async (params, context) => {
      const exec = context.services.exec;
      const bundle = params.bundle as Partial<OpenCodeSessionBundle>;
      if (bundle.agentId !== 'opencode' || typeof bundle.remoteSessionId !== 'string' || typeof bundle.exportJsonBase64 !== 'string') {
        return {
          ok: false,
          code: 'bundle_invalid',
          message: 'OpenCode handoff import received unsupported bundle',
        };
      }
      if (estimateBase64DecodedBytes(bundle.exportJsonBase64) > OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES) {
        return {
          ok: false,
          code: 'bundle_invalid',
          message: `OpenCode handoff import export payload exceeds size limit (${OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES} bytes)`,
        };
      }

      const affinity = bundle.affinity ?? {
        backendMode: null,
        serverBaseUrl: null,
        serverBaseUrlExplicit: false,
      };
      try {
        const executable = await resolveOpenCodeExecutable(exec, 'Import or compare an OpenCode handoff session');
        const sourceExport = decodeOpenCodeImportExportJson(bundle.exportJsonBase64);
        const normalizedSource = normalizeOpenCodeSessionExportForHandoffComparison(
          sourceExport,
          bundle.remoteSessionId,
        );
        if (!normalizedSource) {
          return {
            ok: false,
            code: 'bundle_invalid',
            message: 'OpenCode handoff export payload has an invalid vendor session shape',
          };
        }

        const existingExport = readProcessResult(await exec.run(
          {
            executable,
            args: ['export', bundle.remoteSessionId],
            cwd: { root: 'workspace', relativePath: '' },
            maxStdoutBytes: OPEN_CODE_EXPORT_MAX_BUFFER_BYTES,
          },
          { signal: context.signal },
        ));

        if (existingExport.exitCode === 0) {
          const normalizedExisting = Buffer.byteLength(existingExport.stdout, 'utf8') <= OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES
            ? normalizeOpenCodeSessionExportForHandoffComparison(
              existingExport.stdout,
              bundle.remoteSessionId,
            )
            : null;
          if (normalizedExisting === normalizedSource) {
            return importedSessionResult({
              providerSessionId: bundle.remoteSessionId,
              targetDirectory: params.targetDirectory,
              affinity,
            });
          }
          return {
            ok: false,
            code: 'target_identity_conflict',
            message: `OpenCode target session ${bundle.remoteSessionId} already exists with divergent data`,
          };
        }
        if (!isOpenCodeMissingSessionExport(existingExport.stderr, bundle.remoteSessionId)) {
          return {
            ok: false,
            code: 'target_identity_conflict',
            message: `OpenCode target session ${bundle.remoteSessionId} could not be compared safely`,
          };
        }

        const versionResult = readProcessResult(await exec.run(
          {
            executable,
            args: ['--version'],
            cwd: { root: 'workspace', relativePath: '' },
          },
          { signal: context.signal },
        ));
        const version = versionResult.exitCode === 0 && versionResult.stdout.trim()
          ? versionResult.stdout.trim()
          : 'unknown version';
        // The same pinned version's import command upserts the session and merges
        // messages/parts on conflict. Until an exact resolved binary proves a
        // conditional absent-create primitive, invoking it would violate
        // create-or-identical by racing the read above.
        return {
          ok: false,
          code: 'agent_version_unsupported',
          message: `OpenCode ${version} cannot safely create an absent handoff target`,
        };
      } catch (error) {
        return {
          ok: false,
          code: 'target_import_failed',
          message: error instanceof Error ? error.message : 'OpenCode handoff import failed',
        };
      }
    },
} satisfies AgentRuntimeHandoffSurface;
