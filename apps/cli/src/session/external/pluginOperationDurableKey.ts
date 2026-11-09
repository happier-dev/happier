import { createHash } from 'node:crypto';
import { toUSVString } from 'node:util';

import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { PluginError } from '@happier-dev/plugin-sdk';

export function deriveExternalSessionPluginOperationDurableKey(
  input: Readonly<{
    pluginId: string;
    callerKey: string;
  }>,
): string {
  const pluginId = PluginIdSchema.safeParse(input.pluginId);
  if (!pluginId.success || pluginId.data !== input.pluginId) {
    throw pluginOperationKeyFailure(
      'plugin_external_operation_principal_invalid',
    );
  }
  if (
    typeof input.callerKey !== 'string'
    || input.callerKey.length === 0
    || input.callerKey.length > 256
    || input.callerKey !== input.callerKey.trim()
  ) {
    throw pluginOperationKeyFailure(
      'plugin_external_operation_idempotency_key_invalid',
    );
  }

  const framedPrefix =
    `${pluginId.data.length}:${pluginId.data}\0${input.callerKey.length}:`;
  const hash = createHash('sha256')
    .update('happier.external-sessions.plugin-operation.v1\0', 'utf8')
    .update(framedPrefix, 'utf8');
  if (toUSVString(input.callerKey) !== input.callerKey) {
    // 0xff cannot occur in valid UTF-8, so exact UTF-16 code units cannot
    // alias any legacy well-formed key or another malformed key.
    hash
      .update(Buffer.from([0xff]))
      .update(input.callerKey, 'utf16le');
  } else {
    hash.update(input.callerKey, 'utf8');
  }
  return `plugin-operation:v1:${hash.digest('hex')}`;
}

function pluginOperationKeyFailure(code: string): PluginError {
  return new PluginError({ code, message: code });
}
