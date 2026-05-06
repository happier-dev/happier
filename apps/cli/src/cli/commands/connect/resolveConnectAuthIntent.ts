import {
  getConnectedAccountConnectModesForTarget,
  type ConnectedServiceId,
  type ConnectedAccountTokenKind,
} from '@happier-dev/protocol';

import type { ConnectParsedOptions } from './parseConnectArgs';

export type ConnectAuthIntent =
  | Readonly<{ kind: 'oauth'; serviceId: ConnectedServiceId }>
  | Readonly<{ kind: 'token'; serviceId: ConnectedServiceId; tokenKind: ConnectedAccountTokenKind }>;

export function resolveConnectAuthIntent(params: Readonly<{
  targetId: string;
  options: ConnectParsedOptions;
}>): ConnectAuthIntent {
  const connectModes = getConnectedAccountConnectModesForTarget(params.targetId);
  if (connectModes.length === 0) {
    throw new Error(`Unsupported connect target: ${params.targetId}`);
  }

  const deviceCapable = connectModes.some(({ descriptor, mode }) =>
    mode.credentialKind === 'oauth' && descriptor.ui.oauthAddActionModes.includes('device'),
  );
  if (params.options.device && !deviceCapable) {
    throw new Error(`--device is not supported for ${params.targetId}`);
  }

  const requestedModes = [
    params.options.oauth ? 'oauth' : null,
    params.options.setupToken ? 'setup-token' : null,
    params.options.apiKey ? 'api-key' : null,
    params.options.token ? 'token' : null,
  ].filter(Boolean);
  if (requestedModes.length > 1) {
    const supportedModeFlags = ['oauth', 'setup-token', 'api-key', 'token']
      .filter((mode) => connectModes.some((entry) => entry.mode.mode === mode))
      .map((mode) => `--${mode}`)
      .join(', ');
    throw new Error(`Use only one of: ${supportedModeFlags}`);
  }

  const requestedMode = requestedModes[0] ?? null;
  const selected = requestedMode
    ? connectModes.find(({ mode }) => mode.mode === requestedMode)
    : connectModes.find(({ mode }) => mode.default) ?? connectModes[0] ?? null;

  if (!selected) {
    if (requestedMode) {
      throw new Error(`--${requestedMode} is not supported for ${params.targetId}`);
    }
    throw new Error(`Unsupported connect target: ${params.targetId}`);
  }

  if (selected.mode.credentialKind === 'oauth') {
    return { kind: 'oauth', serviceId: selected.descriptor.id };
  }

  if (!selected.mode.tokenKind) {
    throw new Error(`Connect target ${params.targetId} is missing token setup metadata`);
  }
  return { kind: 'token', serviceId: selected.descriptor.id, tokenKind: selected.mode.tokenKind };
}
