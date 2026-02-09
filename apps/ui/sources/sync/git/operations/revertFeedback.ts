export function shortSha(sha: string): string {
    if (!sha) return sha;
    return sha.length > 8 ? sha.slice(0, 8) : sha;
}

export function buildRevertConfirmBody(input: {
    commit: string;
    branch: string | null;
    detached: boolean;
    detachedLabel: string;
}): string {
    const targetLabel = input.detached
        ? input.detachedLabel
        : input.branch
            ? `branch ${input.branch}`
            : input.detachedLabel;
    const commitLabel = shortSha(input.commit);
    return `This creates a new commit that reverts ${commitLabel} on ${targetLabel}.\n\nHistory is preserved (no reset/rewrite).`;
}
