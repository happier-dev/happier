import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import type { AgentModelConfig } from '@happier-dev/agents';
import { execFileWithDeadline, ExecFileTerminationError } from '@happier-dev/cli-common/process';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { createAgentNativeHomeReadService } from '@/agent/runtime/nativeHomeFileService';
import { resolveConnectedServiceNativeHomeRoot } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { logger } from '@/ui/logger';
import { ProviderProbeCancelledError } from './client';

type NativeTargetDeclaration = NonNullable<NonNullable<AgentModelConfig['nativeCatalogObservation']>['nativeTarget']>;
export type NativeCatalogTarget = Readonly<{
  status: 'ready';
  endpointUrl: string;
  credentialValue: string;
  credentialFingerprint: string;
  headerBindings: NativeTargetDeclaration['credentialSources'][number]['headers'];
}>;
export type NativeCatalogTargetResolution = NativeCatalogTarget | Readonly<{ status: 'absent' | 'unavailable' }>;

function readJsonPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

/** Resolve one endpoint/auth target. A configured failing source cannot select another account. */
export async function resolveNativeCatalogTarget(input: Readonly<{
  observation: NonNullable<AgentModelConfig['nativeCatalogObservation']>;
  catalogEntry: Pick<AgentCatalogEntry, 'getConnectedServiceStateSharingDescriptor'> | null | undefined;
  environment: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  defaultEndpointUrl: string;
  enabledSettingSources: readonly string[];
  signal?: AbortSignal;
  deadlineAtMs?: number;
  retainCleanup?: (cleanup: () => Promise<void>) => Promise<() => void>;
}>): Promise<NativeCatalogTargetResolution> {
  const assertCurrent = () => {
    if (input.signal?.aborted || (input.deadlineAtMs !== undefined && Date.now() >= input.deadlineAtMs)) {
      throw new ProviderProbeCancelledError();
    }
  };
  assertCurrent();
  const declaration = input.observation.nativeTarget;
  if (!declaration) return { status: 'absent' };
  let endpointUrl: string;
  let defaultEndpointUrl: string;
  try {
    defaultEndpointUrl = new URL(input.defaultEndpointUrl).href;
    const explicit = declaration.endpointEnvironmentVariable ? input.environment[declaration.endpointEnvironmentVariable]?.trim() : undefined;
    const endpoint = new URL(explicit || defaultEndpointUrl);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return { status: 'unavailable' };
    endpointUrl = endpoint.href;
  } catch { return { status: 'unavailable' }; }
  const ready = (credentialValue: string, source: NativeTargetDeclaration['credentialSources'][number]): NativeCatalogTarget => ({
    status: 'ready', endpointUrl, credentialValue, headerBindings: source.headers,
    credentialFingerprint: `sha256:${createHash('sha256').update(credentialValue).digest('hex')}`,
  });
  let readService: ReturnType<typeof createAgentNativeHomeReadService> | undefined;
  for (const source of declaration.credentialSources) {
    assertCurrent();
    if (source.kind === 'environment') {
      const value = input.environment[source.variable]?.trim();
      if (value) return ready(value, source);
      continue;
    }
    if (source.kind === 'jsonCommand' && !input.enabledSettingSources.includes(source.requiredSettingSource)) continue;
    if (source.kind === 'jsonFile' && source.defaultEndpointOnly && endpointUrl !== defaultEndpointUrl) continue;
    try {
      if (readService === undefined) {
        const descriptor = await input.catalogEntry?.getConnectedServiceStateSharingDescriptor?.();
        assertCurrent();
        readService = descriptor?.providerSupportStatus === 'supported' && descriptor.nativeHome
          ? createAgentNativeHomeReadService({
            root: resolveConnectedServiceNativeHomeRoot({ nativeHome: descriptor.nativeHome, sourceEnvironment: input.environment, homeDir: homedir() }),
            declaredFileIds: [...descriptor.authIsolation.secretEntries, ...descriptor.config.entries.map(entry => entry.path)],
          }) : null;
      }
      if (!readService) continue;
      const bytes = (await readService.readFiles([source.fileId]))[source.fileId];
      assertCurrent();
      if (!bytes) continue;
      let settings: unknown;
      try {
        settings = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        if (source.kind !== 'jsonCommand' || !(error instanceof SyntaxError)) throw error;
        // Claude skips invalid user settings JSON in noninteractive runs.
        logger.warnLocalFile('[native-catalog] Invalid native helper settings JSON ignored');
        continue;
      }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        if (source.kind === 'jsonCommand') {
          logger.warnLocalFile('[native-catalog] Invalid native helper settings root ignored');
          continue;
        }
        return { status: 'unavailable' };
      }
      const configured = readJsonPath(settings, source.jsonPath);
      if (configured === undefined || configured === null || configured === '') continue;
      if (typeof configured !== 'string') {
        if (source.kind === 'jsonCommand') {
          logger.warnLocalFile('[native-catalog] Invalid native helper command setting ignored');
          continue;
        }
        return { status: 'unavailable' };
      }
      if (configured.trim().length === 0) return { status: 'unavailable' };
      if (source.kind === 'jsonFile') return ready(configured.trim(), source);
      const invalidOutput = new AbortController();
      const signal = input.signal ? AbortSignal.any([input.signal, invalidOutput.signal]) : invalidOutput.signal;
      let token = '';
      let ended = false;
      let invalid = false;
      if (!Number.isSafeInteger(source.maxCredentialLength) || source.maxCredentialLength <= 0) return { status: 'unavailable' };
      let operation: ReturnType<typeof execFileWithDeadline> | undefined;
      const releaseCleanup = await input.retainCleanup?.(async () => {
        await operation?.catch(error => { if (error instanceof ExecFileTerminationError) throw error; });
      });
      try {
        assertCurrent();
        operation = execFileWithDeadline(configured, [], {
          shell: true, cwd: input.cwd, env: input.environment, signal, inputBytes: new Uint8Array(),
          ...(input.deadlineAtMs === undefined ? {} : { timeout: Math.max(0, input.deadlineAtMs - Date.now()) }),
          terminateOnAbort: child => terminateProcessTree(child),
          onStdoutChunk: chunk => {
            if (invalid) return;
            for (const character of chunk) {
              if (/\s/u.test(character)) { if (token.length) ended = true; }
              else if (ended || !/[\x21-\x7e]/u.test(character) || token.length >= source.maxCredentialLength) {
                invalid = true;
                invalidOutput.abort();
                return;
              } else token += character;
            }
          },
        });
        await operation;
      } finally {
        releaseCleanup?.();
      }
      assertCurrent();
      if (!token || invalid) return { status: 'unavailable' };
      return ready(token, source);
    } catch (error) {
      if (error instanceof ExecFileTerminationError) throw error;
      assertCurrent();
      // Commands, output, environment and OS failures may all contain credentials.
      logger.warnLocalFile('[native-catalog] Configured native credential source unavailable; model discovery skipped');
      return { status: 'unavailable' };
    }
  }
  assertCurrent();
  return { status: 'absent' };
}

export function isDynamicModelProbeEnabled(input: Readonly<{
  modelConfig: AgentModelConfig | null | undefined;
  accountSettings: Readonly<Record<string, unknown>> | null;
  environment: Readonly<Record<string, string | undefined>>;
}>): boolean {
  const control = input.modelConfig?.dynamicProbeControl;
  if (!control) return input.modelConfig?.dynamicProbe !== 'static-only';
  const environmentValue = control.environmentVariable
    ? input.environment[control.environmentVariable]?.trim().toLowerCase()
    : undefined;
  if (environmentValue === '0' || environmentValue === 'false') return false;
  return input.accountSettings?.[control.accountSettingId] !== false;
}
