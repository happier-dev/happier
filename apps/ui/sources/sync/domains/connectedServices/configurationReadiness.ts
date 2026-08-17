import type {
  PluginConnectedAccountAuthenticationModeV2,
  QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

export type ConnectedAccountServiceConfigurationStatusByModeId = Readonly<
  Record<string, 'ready' | 'configurationRequired' | undefined>
>;

export function isConnectedAccountServiceConfigurationBlocked(
  statusByModeId: ConnectedAccountServiceConfigurationStatusByModeId | undefined,
  modeId: string,
): boolean {
  return statusByModeId?.[modeId] !== 'ready';
}

export function isConnectedAccountConfigurationBlocked(input: Readonly<{
  account: Pick<QualifiedConnectedAccountProfileV4, 'configurationReady'>;
  authenticationMode: PluginConnectedAccountAuthenticationModeV2 | null;
  serviceConfigurationStatusByModeId?: ConnectedAccountServiceConfigurationStatusByModeId;
}>): boolean {
  const mode = input.authenticationMode;
  if (!mode) return !input.account.configurationReady;
  if (mode.configuration?.scope === 'service') {
    return isConnectedAccountServiceConfigurationBlocked(
      input.serviceConfigurationStatusByModeId,
      mode.id,
    );
  }
  return mode.configuration?.scope === 'account'
    && !input.account.configurationReady;
}
