/** A missing policy never supplies defaults for Storage decisions or effects. */
export function storagePolicyUnavailableError(): Error {
    return Object.assign(new Error('Storage policy is unavailable'), { code: 'policy_unavailable' as const });
}
