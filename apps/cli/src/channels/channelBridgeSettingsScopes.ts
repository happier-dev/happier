import { asRecord, readTrimmedString } from './channelBridgeConfigParsing';

type RecordLike = Record<string, unknown>;

export type ChannelBridgeSettingsScopes = Readonly<{
  channelBridgeGlobal: RecordLike | null;
  channelBridgeServer: RecordLike | null;
  channelBridgeAccount: RecordLike | null;
}>;

export function resolveChannelBridgeSettingsScopes(params: Readonly<{
  settings: unknown;
  serverId?: string | null;
  accountId?: string | null;
}>): ChannelBridgeSettingsScopes {
  const settingsRoot = asRecord(params.settings);
  const channelBridgeGlobal = asRecord(settingsRoot?.channelBridge);

  const byServerId = asRecord(channelBridgeGlobal?.byServerId);
  const scopedServerId = readTrimmedString(params.serverId) ?? '';
  const scopedAccountId = readTrimmedString(params.accountId) ?? '';

  const channelBridgeServer =
    scopedServerId.length > 0 && byServerId
      ? asRecord(byServerId[scopedServerId])
      : null;

  const byAccountId = asRecord(channelBridgeServer?.byAccountId);
  const channelBridgeAccount =
    scopedAccountId.length > 0 && byAccountId
      ? asRecord(byAccountId[scopedAccountId])
      : null;

  return {
    channelBridgeGlobal,
    channelBridgeServer,
    channelBridgeAccount,
  };
}

