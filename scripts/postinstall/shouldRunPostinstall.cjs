function normalizeScopeToken(token) {
    const trimmed = typeof token === 'string' ? token.trim() : ''
    return trimmed.toLowerCase()
}

function parseInstallScope(rawScope) {
    const normalized = normalizeScopeToken(rawScope)
    if (!normalized) return null
    if (normalized === 'all' || normalized === '*') return null

    const tokens = normalized
        .split(/[,\s]+/g)
        .map((t) => normalizeScopeToken(t))
        .filter(Boolean)

    return tokens.length > 0 ? new Set(tokens) : null
}

function shouldRunPostinstall({ workspace, scope }) {
    const workspaceToken = normalizeScopeToken(workspace)
    if (!workspaceToken) return true

    const allowed = parseInstallScope(scope)
    if (!allowed) return true

    return allowed.has(workspaceToken)
}

module.exports = {
    parseInstallScope,
    shouldRunPostinstall,
}
