import type { SystemTaskJsonObject } from './spec.js';

export type ReleaseChannelSwitchForSetupPromptData = Readonly<{
  targetReleaseChannel: string;
  currentDefaultReleaseChannel: string | null;
  targetServerUrl: string | null;
  managedReleaseChannels: ReadonlyArray<ManagedReleaseChannelPromptEntry>;
}>;

export type ManagedReleaseChannelPromptEntry = Readonly<{
  releaseChannel: string;
  label: string;
  version: string | null;
  installationId: string;
  installationPath: string;
  invokerName: string;
  isDefault: boolean;
  onPath: boolean;
}>;

export type ReplaceLocalBackgroundServicesPromptData = Readonly<{
  targetReleaseChannel: string | null;
  targetServerUrl: string | null;
  services: ReadonlyArray<BackgroundServicePromptEntryWithServer>;
}>;

export type ReplaceRemoteBackgroundServicesPromptData = Readonly<{
  targetReleaseChannel: string | null;
  targetServerUrl: string | null;
  services: ReadonlyArray<BackgroundServicePromptEntry>;
}>;

export type BackgroundServicePromptEntry = Readonly<{
  label: string;
  releaseChannel: string | null;
  targetMode: string | null;
  running: boolean;
}>;

export type BackgroundServicePromptEntryWithServer = BackgroundServicePromptEntry & Readonly<{
  serverUrl: string | null;
}>;

export type SshTrustPromptData = Readonly<{
  kind: 'ssh.trustHost' | 'ssh.replaceHostKey';
  host: string;
  keyType: string | null;
  fingerprint: string;
  existingFingerprint: string | null;
}>;

export type ApproveRemoteProvisioningPromptData = Readonly<{
  publicKey: string | null;
}>;

export type SshPasswordPromptData = Readonly<{
  target: string;
}>;

function readTrimmedString(record: SystemTaskJsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseBackgroundServicePromptEntry(
  entry: unknown,
): BackgroundServicePromptEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const item = entry as SystemTaskJsonObject;
  const label = readTrimmedString(item, 'label');
  if (!label) {
    return null;
  }

  return {
    label,
    releaseChannel: readTrimmedString(item, 'releaseChannel'),
    targetMode: readTrimmedString(item, 'targetMode'),
    running: item.running === true,
  };
}

export function parseReleaseChannelSwitchForSetupPromptData(
  record: SystemTaskJsonObject,
): ReleaseChannelSwitchForSetupPromptData | null {
  const targetReleaseChannel = readTrimmedString(record, 'targetReleaseChannel');
  if (!targetReleaseChannel) {
    return null;
  }

  const managedReleaseChannelsRaw = Array.isArray(record.managedReleaseChannels)
    ? record.managedReleaseChannels
    : [];
  const managedReleaseChannels = managedReleaseChannelsRaw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }

    const item = entry as SystemTaskJsonObject;
    const releaseChannel = readTrimmedString(item, 'releaseChannel');
    const label = readTrimmedString(item, 'label');
    const installationId = readTrimmedString(item, 'installationId');
    const installationPath = readTrimmedString(item, 'installationPath');
    const invokerName = readTrimmedString(item, 'invokerName');
    if (!releaseChannel || !label || !installationId || !installationPath || !invokerName) {
      return [];
    }

    return [{
      releaseChannel,
      label,
      version: readTrimmedString(item, 'version'),
      installationId,
      installationPath,
      invokerName,
      isDefault: item.isDefault === true,
      onPath: item.onPath === true,
    } satisfies ManagedReleaseChannelPromptEntry];
  });

  return {
    targetReleaseChannel,
    currentDefaultReleaseChannel: readTrimmedString(record, 'currentDefaultReleaseChannel'),
    targetServerUrl: readTrimmedString(record, 'targetServerUrl'),
    managedReleaseChannels,
  };
}

export function parseReplaceLocalBackgroundServicesPromptData(
  record: SystemTaskJsonObject,
): ReplaceLocalBackgroundServicesPromptData {
  const servicesRaw = Array.isArray(record.services) ? record.services : [];
  const services = servicesRaw.flatMap((entry) => {
    const parsed = parseBackgroundServicePromptEntry(entry);
    if (!parsed) {
      return [];
    }

    const item = entry as SystemTaskJsonObject;
    return [{
      ...parsed,
      serverUrl: readTrimmedString(item, 'serverUrl'),
    } satisfies BackgroundServicePromptEntryWithServer];
  });

  return {
    targetReleaseChannel: readTrimmedString(record, 'targetReleaseChannel'),
    targetServerUrl: readTrimmedString(record, 'targetServerUrl'),
    services,
  };
}

export function parseReplaceRemoteBackgroundServicesPromptData(
  record: SystemTaskJsonObject,
): ReplaceRemoteBackgroundServicesPromptData {
  const servicesRaw = Array.isArray(record.services) ? record.services : [];
  const services = servicesRaw.flatMap((entry) => {
    const parsed = parseBackgroundServicePromptEntry(entry);
    return parsed ? [parsed] : [];
  });

  return {
    targetReleaseChannel: readTrimmedString(record, 'targetReleaseChannel'),
    targetServerUrl: readTrimmedString(record, 'targetServerUrl'),
    services,
  };
}

export function parseSshTrustPromptData(
  kind: 'ssh.trustHost' | 'ssh.replaceHostKey',
  record: SystemTaskJsonObject,
): SshTrustPromptData | null {
  const host = readTrimmedString(record, 'host');
  const fingerprint = readTrimmedString(record, 'fingerprint');
  if (!host || !fingerprint) {
    return null;
  }

  return {
    kind,
    host,
    keyType: readTrimmedString(record, 'keyType'),
    fingerprint,
    existingFingerprint: readTrimmedString(record, 'existingFingerprint'),
  };
}

export function parseApproveRemoteProvisioningPromptData(
  record: SystemTaskJsonObject,
): ApproveRemoteProvisioningPromptData {
  return {
    publicKey: readTrimmedString(record, 'publicKey'),
  };
}

export function parseSshPasswordPromptData(
  record: SystemTaskJsonObject,
): SshPasswordPromptData {
  return {
    target: readTrimmedString(record, 'target') ?? '',
  };
}
