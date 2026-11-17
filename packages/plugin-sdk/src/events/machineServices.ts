export { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, BackupOutcomeEventV1ProtocolSchema,
    MachinePressureEventV1ProtocolSchema, WorktreeRemovedEventV1ProtocolSchema,
    GuardStoppedEventV1ProtocolSchema, ConnectedServiceQuotaEventV1ProtocolSchema, ConnectedServiceCredentialHealthEventV1ProtocolSchema, ProjectSetupSettledEventV1ProtocolSchema } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
export type { MachineServiceObservationV1, WorktreeRemovedEventV1, GuardStoppedEventV1, ConnectedServiceQuotaEventV1, ConnectedServiceCredentialHealthEventV1, ProjectSetupSettledEventV1 }
    from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';

export { SCM_WORKTREE_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/scmActionIdsV1';
export { PROJECT_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
export { MACHINE_OUTCOME_SUMMARY_PREFIX, machineOutcomeSummaryAddress } from '@happier-dev/protocol/machines/resources/machineOutcomeSummaryV1';
export type { MachineResourceOutcomeV1 } from '@happier-dev/protocol/machines/resources/machineOutcomeSummaryV1';
export { MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineResourcesActionIdsV1';
