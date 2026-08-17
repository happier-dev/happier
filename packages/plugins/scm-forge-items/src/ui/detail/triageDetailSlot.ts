export type TriageDetailSourceContribution = Readonly<{
    pluginId: string
    contributionId: string
}>

export type TriageDetailIdentity = Readonly<{
    sourceContribution: TriageDetailSourceContribution
    sourceInstanceId: string
    entryId: string
}>

export type TriageDetailSelection<TSurface, TInput> = Readonly<{
    identity: TriageDetailIdentity
    surface: TSurface
    input: TInput
}>

export type TriageDetailSlot<TSurface, TInput, TCachedFallback> = Readonly<
    TriageDetailSelection<TSurface, TInput> & {
        instanceKey: string
        cachedFallback?: TCachedFallback
    }
>

/**
 * The target-owned identity intentionally excludes observation freshness and
 * contribution generations. TargetedSurface owns source lifecycle and currentness.
 */
export const createTriageDetailInstanceKey = (identity: TriageDetailIdentity): string =>
    JSON.stringify([
        identity.sourceContribution.pluginId,
        identity.sourceContribution.contributionId,
        identity.sourceInstanceId,
        identity.entryId,
    ])

/**
 * Target-side selection and exact-identity fallback state. This store does not
 * cancel or version source work; the eventual TargetedSurface mount owns that.
 */
export class TriageDetailSlotStore<TSurface, TInput, TCachedFallback> {
    readonly #fallbackByInstanceKey = new Map<string, TCachedFallback>()
    #current: TriageDetailSlot<TSurface, TInput, TCachedFallback> | undefined

    select(selection: TriageDetailSelection<TSurface, TInput>): TriageDetailSlot<TSurface, TInput, TCachedFallback> {
        const instanceKey = createTriageDetailInstanceKey(selection.identity)
        const cachedFallback = this.#fallbackByInstanceKey.get(instanceKey)
        const current = cachedFallback === undefined
            ? { ...selection, instanceKey }
            : { ...selection, instanceKey, cachedFallback }

        this.#current = current
        return current
    }

    current(): TriageDetailSlot<TSurface, TInput, TCachedFallback> | undefined {
        return this.#current
    }

    rememberFallback(identity: TriageDetailIdentity, fallback: TCachedFallback): boolean {
        const instanceKey = createTriageDetailInstanceKey(identity)
        if (this.#current?.instanceKey !== instanceKey) {
            return false
        }

        this.#fallbackByInstanceKey.set(instanceKey, fallback)
        this.#current = { ...this.#current, cachedFallback: fallback }
        return true
    }
}
