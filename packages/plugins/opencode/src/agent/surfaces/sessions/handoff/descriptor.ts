import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/sessions';
import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import {
  type HandoffSurfaceV1,
  type SessionStateUpdateV1,
} from '@happier-dev/plugin-sdk';
import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import {
  readOpenCodeProviderSessionIdFromMetadata,
} from '../../../identity/session.js';
import {
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
  type OpenCodeSessionAffinity,
} from '../../../identity/affinity.js';
import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';

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

function resolveOpenCodeImportFileName(providerSessionId: string): string {
  if (!providerSessionId || providerSessionId.includes('/') || providerSessionId.includes('\\')) {
    throw new Error(`Invalid providerSessionId for OpenCode handoff: ${providerSessionId}`);
  }
  return `${providerSessionId}.json`;
}

function sessionStateUpdatesForImportedSession(params: Readonly<{
  providerSessionId: string;
  backendMode: 'server';
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): SessionStateUpdateV1[] {
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

export function createOpenCodeHandoffSurface(ctx: PluginContextV1): HandoffSurfaceV1 {
  return createOpenCodeHandoffSurfaceForExec(ctx.agentRuntime.exec);
}

export function createOpenCodeHandoffSurfaceForExec(exec: Pick<ExecRuntimeServiceV1, 'run'>): HandoffSurfaceV1 {
  return {
    exportBundle: async (params) => {
      const providerSessionId = readOpenCodeProviderSessionIdFromMetadata(params.metadata);
      if (!providerSessionId) {
        return {
          ok: false,
          code: 'bundle_invalid',
          message: 'OpenCode handoff export requires a provider session id',
        };
      }

      try {
        const result = await exec.run(
          { kind: 'agent-cli', agentId: 'opencode', args: ['export', providerSessionId] },
          { maxStdoutBytes: OPEN_CODE_EXPORT_MAX_BUFFER_BYTES },
        );
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
    importBundle: async (params) => {
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
      const tempDir = await mkdtemp(join(tmpdir(), 'handoff-opencode-'));
      const importPath = join(tempDir, resolveOpenCodeImportFileName(bundle.remoteSessionId));
      try {
        await writeFile(importPath, decodeOpenCodeImportExportJson(bundle.exportJsonBase64), 'utf8');
        const result = await exec.run({
          kind: 'agent-cli',
          agentId: 'opencode',
          args: ['import', importPath],
        });
        if (result.exitCode !== 0) {
          return {
            ok: false,
            code: 'target_import_failed',
            message: result.stderr.trim() || 'OpenCode handoff import failed',
          };
        }

        const backendMode = 'server';
        const serverBaseUrl = affinity.serverBaseUrlExplicit ? affinity.serverBaseUrl : null;
        const source: ExternalSessionsSource = {
          kind: 'opencodeServer',
          ...(serverBaseUrl ? { baseUrl: serverBaseUrl } : {}),
          directory: params.targetDirectory,
        };

        return {
          ok: true,
          value: {
            providerSessionId: bundle.remoteSessionId,
            source,
            launch: {
              directory: params.targetDirectory,
              environmentVariables: buildOpenCodeSessionEnvironmentVariables({
                backendMode,
                serverBaseUrl,
                serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
              }),
              sessionStateUpdates: sessionStateUpdatesForImportedSession({
                providerSessionId: bundle.remoteSessionId,
                backendMode,
                ...(serverBaseUrl ? { serverBaseUrl } : {}),
                serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
              }),
            },
          },
        };
      } catch (error) {
        return {
          ok: false,
          code: 'target_import_failed',
          message: error instanceof Error ? error.message : 'OpenCode handoff import failed',
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}
