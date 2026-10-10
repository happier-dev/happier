/** Task-kind adaptation only; Protocol owns the public Action contract and policy. */
export const LOCAL_RELAY_RUNTIME_ACTION_IDS = {
    'relay.runtime.status.v1': 'relay.runtime.status',
    'relay.runtime.installOrUpdate.v1': 'relay.runtime.install_or_update',
    'relay.runtime.start.v1': 'relay.runtime.start',
    'relay.runtime.stop.v1': 'relay.runtime.stop',
    'relay.runtime.restart.v1': 'relay.runtime.restart',
    'relay.runtime.uninstall.v1': 'relay.runtime.uninstall',
    'relay.runtime.personal_home.inspect.v1': 'relay.runtime.personal_home.inspect',
    'relay.runtime.personal_home.backup.v1': 'relay.runtime.personal_home.backup',
    'relay.runtime.personal_home.verify_backup.v1': 'relay.runtime.personal_home.verify_backup',
    'relay.runtime.personal_home.restore.v1': 'relay.runtime.personal_home.restore',
    'relay.runtime.personal_home.erase.v1': 'relay.runtime.personal_home.erase',
    'relay.runtime.personal_home.claim_owner.v1': 'relay.runtime.personal_home.claim',
} as const;
