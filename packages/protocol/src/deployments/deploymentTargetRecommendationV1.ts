import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';

const target = () => z.strictObject({ id, targetClass: z.enum(['ownServer', 'platform']) });
/** Presentation facts only: neither availability nor a recommendation authorizes a deployment. */
export const DeploymentTargetRecommendationV1Schema = lazyZodSchema(() => z.strictObject({
    target: z.nullable(target()),
    compatibleTargetIds: z.array(id),
    offeredTargetIds: z.array(id),
    evidence: z.array(z.enum(['explicit_target', 'existing_target', 'stored_definition', 'repository_compose'])),
    uncertainty: z.array(z.enum(['project_shape_unknown', 'platform_source_capability_unknown', 'machine_availability_unknown'])),
    corrections: z.array(z.strictObject({ targetId: id, kind: z.enum(['choose_machine', 'prepare_repository', 'repair_target']) })),
}));
export type DeploymentTargetRecommendationV1 = z.infer<typeof DeploymentTargetRecommendationV1Schema>;
