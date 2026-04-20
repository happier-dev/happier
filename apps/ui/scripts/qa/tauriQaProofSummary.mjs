function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

export function hasCompleteQaStepArtifacts(artifacts) {
    if (!artifacts || typeof artifacts !== 'object') {
        return false;
    }

    return isNonEmptyString(artifacts.screenshotPath)
        && isNonEmptyString(artifacts.structurePath)
        && isNonEmptyString(artifacts.a11yPath);
}

export function summarizeQaStepArtifactsProof({
    stepArtifacts = {},
    requiredStepIds = [],
    emptyBlocker = 'no_step_artifacts_captured',
    incompleteBlocker = 'missing_required_step_artifacts',
} = {}) {
    const normalizedStepArtifacts = stepArtifacts && typeof stepArtifacts === 'object'
        ? stepArtifacts
        : {};
    const steps = Object.keys(normalizedStepArtifacts);
    const normalizedRequiredStepIds = Array.isArray(requiredStepIds)
        ? requiredStepIds.filter((stepId) => typeof stepId === 'string' && stepId.trim().length > 0)
        : [];
    if (steps.length === 0) {
        return {
            ok: false,
            blocker: emptyBlocker,
            steps: normalizedRequiredStepIds.length > 0 ? normalizedRequiredStepIds : steps,
        };
    }

    if (normalizedRequiredStepIds.length === 0) {
        return {
            ok: false,
            blocker: incompleteBlocker,
            steps,
        };
    }

    const missingRequiredStepIds = normalizedRequiredStepIds.filter((stepId) => !hasCompleteQaStepArtifacts(normalizedStepArtifacts[stepId]));
    if (missingRequiredStepIds.length > 0) {
        return {
            ok: false,
            blocker: incompleteBlocker,
            steps: normalizedRequiredStepIds,
        };
    }

    return {
        ok: true,
        blocker: null,
        steps,
    };
}
