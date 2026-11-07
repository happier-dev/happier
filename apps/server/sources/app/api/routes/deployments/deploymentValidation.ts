import type { DeploymentInvalidV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

type Diagnostic = NonNullable<DeploymentInvalidV1['diagnostic']>;

/** Project request-validation refusals without exposing submitted values or validator prose. */
export function deploymentLinkValidationFailure(step: Diagnostic['step'],
    issues: readonly Readonly<{ instancePath: string; keyword: string }>[] | undefined,
    fields: Readonly<Record<string, unknown>>,
): DeploymentInvalidV1 {
    const issue = issues?.[0];
    const candidate = issue?.instancePath.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~');
    const field = candidate && Object.hasOwn(fields, candidate) ? candidate : '$input';
    let rule: Diagnostic['rule'];
    switch (issue?.keyword) {
        case 'invalid_type': case 'unrecognized_keys': case 'invalid_value': case 'path_mismatch':
            rule = issue.keyword;
            break;
        default: rule = 'constraint';
    }
    return { ok: false, error: 'deployment_invalid', diagnostic: { step, field, rule } };
}
