export const REMOTE_HOST_ACTION_IDS_V1 = [
  'remote_hosts.list',
  'remote_hosts.read',
  'remote_hosts.add',
  'remote_hosts.edit',
  'remote_hosts.save',
  'remote_hosts.duplicate',
  'remote_hosts.delete',
  'remote_hosts.connect',
  'remote_hosts.setup_as_machine',
  'remote_hosts.relay.use',
  'remote_hosts.relay.configure',
  'remote_hosts.relay.test',
  'remote_hosts.cli.install_or_update',
  'remote_hosts.daemon.install_or_update',
  'remote_hosts.daemon.start',
  'remote_hosts.daemon.stop',
  'remote_hosts.daemon.restart',
  'remote_hosts.relay.status',
  'remote_hosts.relay.install_or_update',
  'remote_hosts.relay.start',
  'remote_hosts.relay.stop',
  'remote_hosts.relay.restart',
  'remote_hosts.credential.change',
  'remote_hosts.personal_home.erase',
] as const;
export type RemoteHostActionIdV1 = typeof REMOTE_HOST_ACTION_IDS_V1[number];
export function isRemoteHostActionIdV1(value: string): value is RemoteHostActionIdV1 {
  return (REMOTE_HOST_ACTION_IDS_V1 as readonly string[]).includes(value);
}

