import { PluginJsonValueV2Schema } from '@happier-dev/protocol';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
  machineContributionRegistryProjectionDescribe,
  machinePluginStructuredMessageActionExecute,
} from '@/sync/ops/machineContributionRegistryProjection';
import { resolveVoiceExecutionMachineId } from '@/voice/settings/executionMachine';
import type { VoiceAccountOperationAttemptService } from './accountVoiceOperationService';

const MAX_ACTION_RESPONSE_BYTES = 64 * 1024;

type DescribeProjection = typeof machineContributionRegistryProjectionDescribe;
type ExecuteAction = typeof machinePluginStructuredMessageActionExecute;

function operationError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function composeSignal(left: AbortSignal, right: AbortSignal): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (left.aborted || right.aborted) controller.abort();
  else {
    left.addEventListener('abort', abort, { once: true });
    right.addEventListener('abort', abort, { once: true });
  }
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      left.removeEventListener('abort', abort);
      right.removeEventListener('abort', abort);
    },
  });
}

function parseActionResponse(value: unknown): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw operationError('voice_account_operation_invalid_response');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4
    || !keys.every((key) => (
      key === 'status'
      || key === 'finalUrl'
      || key === 'headers'
      || key === 'body'
    ))
  ) {
    throw operationError('voice_account_operation_invalid_response');
  }
  const status = record.status;
  const finalUrl = record.finalUrl;
  const headersLike = record.headers;
  if (
    typeof status !== 'number'
    || !Number.isInteger(status)
    || status < 100
    || status > 599
    || typeof finalUrl !== 'string'
    || !headersLike
    || typeof headersLike !== 'object'
    || Array.isArray(headersLike)
  ) {
    throw operationError('voice_account_operation_invalid_response');
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headersLike)) {
    if (typeof headerValue !== 'string') {
      throw operationError('voice_account_operation_invalid_response');
    }
    headers[name] = headerValue;
  }
  const parsedBody = PluginJsonValueV2Schema.safeParse(record.body);
  if (!parsedBody.success) {
    throw operationError('voice_account_operation_invalid_response');
  }
  const body = new TextEncoder().encode(JSON.stringify(parsedBody.data));
  if (body.byteLength > MAX_ACTION_RESPONSE_BYTES) {
    throw operationError('voice_account_operation_invalid_response');
  }
  return Object.freeze({
    status,
    finalUrl,
    headers: Object.freeze(headers),
    body,
  });
}

export function createDaemonActionVoiceOperationService(input: Readonly<{
  pluginId: string;
  actionLocalId: string;
  conversationSessionId: string | null;
  signal: AbortSignal;
  isCurrent(): boolean;
  resolveMachineId?: () => string | null;
  resolveServerId?: () => string | null;
  describeProjection?: DescribeProjection;
  execute?: ExecuteAction;
}>): VoiceAccountOperationAttemptService {
  const resolveMachineId = input.resolveMachineId ?? resolveVoiceExecutionMachineId;
  const resolveServerId = input.resolveServerId
    ?? (() => getActiveServerSnapshot().serverId);
  const describeProjection =
    input.describeProjection ?? machineContributionRegistryProjectionDescribe;
  const execute = input.execute ?? machinePluginStructuredMessageActionExecute;
  const qualifiedActionId = `${input.pluginId}/${input.actionLocalId}`;
  const assertCurrent = (machineId: string, serverId: string | null): void => {
    if (
      !input.isCurrent()
      || input.signal.aborted
      || resolveMachineId() !== machineId
      || resolveServerId() !== serverId
    ) {
      throw operationError('voice_account_operation_cancelled');
    }
  };
  const inspectAvailability = async (
    signal: AbortSignal,
  ): Promise<Readonly<{
    machineId: string;
    serverId: string | null;
    expectedGeneration: string;
  }>> => {
    const machineId = resolveMachineId();
    const serverId = resolveServerId();
    if (!machineId || signal.aborted || !input.isCurrent()) {
      throw operationError('voice_account_operation_cancelled');
    }
    const projected = await describeProjection(machineId, {
      serverId,
      signal,
    });
    assertCurrent(machineId, serverId);
    if (!projected.supported || projected.projection.v !== 2) {
      throw operationError('voice_account_operation_unavailable');
    }
    const action = projected.projection.actionsById[qualifiedActionId];
    if (
      !action
      || action.id !== input.actionLocalId
      || action.pluginId !== input.pluginId
      || !action.surfaces.includes('ui')
      || action.available === false
    ) {
      throw operationError('voice_account_operation_unavailable');
    }
    return Object.freeze({
      machineId,
      serverId,
      expectedGeneration: String(projected.projection.generation),
    });
  };
  return Object.freeze({
    async inspectAvailability() {
      await inspectAvailability(input.signal);
    },
    async request(request) {
      const signals = composeSignal(input.signal, request.signal);
      try {
        const availability = await inspectAvailability(signals.signal);
        const executed = await execute(availability.machineId, {
          serverId: availability.serverId,
          expectedGeneration: availability.expectedGeneration,
          qualifiedActionId,
          input: PluginJsonValueV2Schema.parse({
            operationId: request.operationId,
            parameters: request.parameters,
          }),
          ...(input.conversationSessionId
            ? { sessionId: input.conversationSessionId }
            : {}),
          executionSurface: 'ui',
          signal: signals.signal,
        });
        assertCurrent(availability.machineId, availability.serverId);
        if (!executed.supported) {
          throw operationError('voice_account_operation_unavailable');
        }
        if (!executed.result.ok) {
          throw operationError(executed.result.code);
        }
        return parseActionResponse(executed.result.result);
      } finally {
        signals.dispose();
      }
    },
  });
}
