export const MACHINE_REMOVE_ACTION_ID_V1 = 'machines.remove' as const;
export const MACHINE_REPLACEMENT_SET_ACTION_ID_V1 = 'machines.replacement.set' as const;
export const MACHINE_REPLACEMENT_CLEAR_ACTION_ID_V1 = 'machines.replacement.clear' as const;
export const PERSONAL_HOME_CREATE_ACTION_ID_V1 = 'homes.personal.create' as const;
export const MACHINE_PAIRING_CANCEL_ACTION_ID_V1 = 'machines.pairing.cancel' as const;

/** Action identity leaf: schema modules and the registry share these constants. */
export const MACHINE_RUN_MARKERS_LIST_ACTION_ID = 'machines.runs.list' as const;
export const MACHINE_CAPABILITIES_DETECT_ACTION_ID = 'machines.capabilities.detect' as const;
export const MACHINE_DOCTOR_SNAPSHOT_ACTION_ID = 'machines.doctor.snapshot' as const;
export const MACHINE_SECURITY_INSPECT_ACTION_ID_V1 = 'machines.security.inspect' as const;
export const MACHINE_ACTIVITY_LIST_ACTION_ID = 'machines.activity.list' as const;
export const MACHINE_PAGE_ACTION_IDS = [MACHINE_DOCTOR_SNAPSHOT_ACTION_ID, MACHINE_SECURITY_INSPECT_ACTION_ID_V1, 'machines.metadata.update', 'machines.daemon.stop', MACHINE_REMOVE_ACTION_ID_V1, MACHINE_RUN_MARKERS_LIST_ACTION_ID, MACHINE_CAPABILITIES_DETECT_ACTION_ID, 'machines.capabilities.install', MACHINE_REPLACEMENT_SET_ACTION_ID_V1, MACHINE_REPLACEMENT_CLEAR_ACTION_ID_V1] as const;
export const MACHINE_MANAGED_INSTALLATION_ACTION_IDS = ['machines.managed.bootstrap.respond'] as const;
export const MACHINE_ADD_SSH_ACTION_IDS = ['machines.add.ssh.start', 'machines.add.ssh.status', 'machines.add.ssh.respond', 'machines.add.ssh.cancel'] as const;

export function isMachineManagedInstallationActionIdV1(actionId: string): actionId is typeof MACHINE_MANAGED_INSTALLATION_ACTION_IDS[number] {
    return MACHINE_MANAGED_INSTALLATION_ACTION_IDS.some(id => id === actionId);
}
