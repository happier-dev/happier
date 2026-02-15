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
}): boolean {
    if (!isAutomationSocketUpdateType(params.updateType)) {
        return false;
    }
    params.invalidateAutomations();
    return true;
}
