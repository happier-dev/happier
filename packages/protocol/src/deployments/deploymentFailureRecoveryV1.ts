import { z } from 'zod/mini';
import { isRecord } from '../common/records.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectActionFailureRecoveryV1 } from '../actions/actionExecutionResult.js';

/** The fallback names the unavailable result, never an invented provider prerequisite. */
export const DeploymentFailureRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
    requiredFact: z.literal('deploymentActionResult'),
    remedy: z.string().check(z.trim(), z.minLength(1)),
}));

/** Recovery is independent of refusal codes; authored native facts always take precedence. */
export function projectDeploymentFailureRecoveryV1<T extends Record<string, unknown>>(details: T): T & {
    requiredFact: string; remedy: string;
} {
    const failure = isRecord(details.failure) ? details.failure : undefined;
    const sourceAdmission = isRecord(details.sourceAdmission) ? details.sourceAdmission
        : isRecord(failure?.sourceAdmission) ? failure.sourceAdmission : undefined;
    return projectActionFailureRecoveryV1({ ...details,
        requiredFact: typeof details.requiredFact === 'string'
            && !(details.step === 'native_execution'
                && DeploymentFailureRecoveryV1Schema.shape.requiredFact.safeParse(details.requiredFact).success) ? details.requiredFact
            : typeof failure?.requiredFact === 'string' ? failure.requiredFact
                : typeof sourceAdmission?.requiredFact === 'string' ? sourceAdmission.requiredFact
                    : undefined,
        remedy: typeof details.remedy === 'string' ? details.remedy
            : typeof failure?.remedy === 'string' ? failure.remedy
                : typeof sourceAdmission?.remedy === 'string' ? sourceAdmission.remedy
                    : undefined,
    }, {
        requiredFact: details.step === 'native_execution' ? 'nativeExecutionResult' : 'deploymentActionResult',
        remedy: 'Inspect the reported deployment phase and current target state. Restore the missing prerequisite or choose a supported target action, then retry the original request after confirming whether the previous change took effect.',
    });
}
