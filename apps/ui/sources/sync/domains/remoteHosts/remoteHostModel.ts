import { RemoteHostAuthModeV1Schema, RemoteHostRecordV1Schema, RemoteHostSshProfileV1Schema,
    type RemoteHostRecordV1, type RemoteHostAuthModeV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';

export type RemoteHostId = string;

export const RemoteHostAuthModeSchema = RemoteHostAuthModeV1Schema;
export type RemoteHostAuthMode = RemoteHostAuthModeV1;
export const RemoteHostSshProfileSchema = RemoteHostSshProfileV1Schema;
export type RemoteHostSshProfile = RemoteHostRecordV1['ssh'];
export const RemoteHostSchema = RemoteHostRecordV1Schema;
export type RemoteHost = RemoteHostRecordV1;
