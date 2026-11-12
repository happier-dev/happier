import { isPluginError } from '@happier-dev/protocol/plugins/errors';

/** Known producer failures keep their identity; an unproved effect remains unknown. */
export function resolveVoiceToolExecutionFailure(error: unknown, effectful: boolean): Readonly<{
  ok: false;
  errorCode: string;
  details?: unknown;
}> {
  if (isPluginError(error)) {
    const details: unknown = Reflect.get(error.data, 'details');
    return { ok: false, errorCode: error.code, ...(details === undefined ? {} : { details }) };
  }
  return { ok: false, errorCode: effectful ? 'outcome_unknown' : 'tool_failed' };
}
