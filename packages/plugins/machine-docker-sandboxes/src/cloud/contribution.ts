import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, RETENTION, LaunchSchema, ResourceSchema, OperationSchema } from './schemas.js';

export const DOCKER_CLOUD_PROVISIONER = {
  title: 'Docker cloud', icon: 'cloud', resourceKind: 'docker-cloud-sandbox', schemaVersion: 1, enrollmentRole: 'sandbox',
  kindTitle: 'Cloud sandbox', description: 'A remote Docker sandbox. Running compute, snapshots and retained storage may be billed.',
  launchSchema: LaunchSchema.jsonSchema, resourceSchema: ResourceSchema.jsonSchema, resourceIdPath: 'sandboxName',
  sessionPlacement: { kind: 'remote', supportsAgentNativeSandbox: false },
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [], billing: BILLING, retention: RETENTION,
  nativeDurationInput: { path: 'timeoutSeconds', unit: 'seconds' },
  actions: { check: 'cloud-check', options: 'cloud-options', acquire: 'cloud-acquire', bootstrap: 'cloud-bootstrap',
    inspect: 'cloud-inspect', power: 'cloud-power', destroy: 'cloud-destroy' },
  bootstrapTransport: { kind: 'native', exec: 'cloud-exec', putFile: 'cloud-put-file' },
  reconciliation: { nativeOperationSchema: OperationSchema.jsonSchema, action: 'cloud-reconcile' },
} satisfies MachineProvisionerAuthorDefinitionV1;
