/** Provider permission outcome, independent of whether the accepted tool executed successfully. */
export function readClaudeToolResultPermissionApproval(value: unknown): boolean | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const rawDecision = row.permissionDecision;
    const decision = rawDecision && typeof rawDecision === 'object' && !Array.isArray(rawDecision)
        ? (rawDecision as Record<string, unknown>).decision
        : null;
    if (decision === 'accept') return true;
    if (decision === 'reject' || row.toolDenialKind === 'user-rejected') return false;
    return null;
}
