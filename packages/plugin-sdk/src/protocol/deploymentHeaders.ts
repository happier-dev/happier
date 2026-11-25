import { DeploymentEnvironmentHeaderV1Schema, DeploymentReceiptHeaderV1Schema,
    DeploymentReceiptOperationV1ProtocolSchema,
    type DeploymentEnvironmentHeaderV1, type DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentHeadersV1';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import type { ProtocolComposableSchema } from './protocolFacade.js';

export type { DeploymentEnvironmentHeaderV1, DeploymentReceiptHeaderV1 };

export const ProtocolDeploymentEnvironmentHeaderV1Schema: ProtocolComposableSchema<unknown, DeploymentEnvironmentHeaderV1> =
    projectZodProtocolSchema(DeploymentEnvironmentHeaderV1Schema);
export const ProtocolDeploymentReceiptHeaderV1Schema: ProtocolComposableSchema<unknown, DeploymentReceiptHeaderV1> =
    projectZodProtocolSchema(DeploymentReceiptHeaderV1Schema);
export const ProtocolDeploymentReceiptOperationV1Schema: ProtocolComposableSchema<DeploymentReceiptHeaderV1['operation']> =
    DeploymentReceiptOperationV1ProtocolSchema;
