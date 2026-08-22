import { createHash } from 'node:crypto';

import { PluginIdSchema } from '@happier-dev/protocol';
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
  if (hasLoneUtf16Surrogate(input.callerKey)) {
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

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function pluginOperationKeyFailure(code: string): PluginError {
  return new PluginError({ code, message: code });
}
