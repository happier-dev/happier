export function isAutomationSocketUpdateType(type: string): boolean {
    return (
        type === 'automation-upsert'
        || type === 'automation-delete'
        || type === 'automation-run-updated'
        || type === 'automation-assignment-updated'
    );
}

export function applyAutomationSocketUpdate(params: {
    updateType: string;
    invalidateAutomations: () => void;
    invalidateAutomationsCoalesced?: () => void;
}): boolean {
    if (!isAutomationSocketUpdateType(params.updateType)) {
        return false;
    }
    const invalidate = params.invalidateAutomationsCoalesced ?? params.invalidateAutomations;
    invalidate();
    return true;
}
