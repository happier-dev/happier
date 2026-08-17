import { describe, expect, it } from 'vitest'

import {
    createTriageDetailInstanceKey,
    TriageDetailSlotStore,
    type TriageDetailIdentity,
} from './triageDetailSlot.js'

const githubSource = (sourceInstanceId: string, entryId = 'pull-request:42'): TriageDetailIdentity => ({
    sourceContribution: {
        pluginId: '@happier-dev/plugins-scm-github',
        contributionId: 'scm-github-forge-items',
    },
    sourceInstanceId,
    entryId,
})

describe('TriageDetailSlotStore', () => {
    it('replaces launch input without resetting the same source-instance-entry slot', () => {
        const store = new TriageDetailSlotStore<object, { readonly revision: string }, string>()
        const identity = githubSource('github:octo/widgets')
        const initialInput = { revision: 'observed-at-1' }

        const initial = store.select({
            identity,
            surface: { handle: 'github-detail' },
            input: initialInput,
        })
        expect(store.rememberFallback(identity, 'cached pull request')).toBe(true)

        const replacementInput = { revision: 'observed-at-2' }
        const replacement = store.select({
            identity,
            surface: { handle: 'github-detail' },
            input: replacementInput,
        })

        expect(replacement.instanceKey).toBe(initial.instanceKey)
        expect(replacement.input).toBe(replacementInput)
        expect(replacement.cachedFallback).toBe('cached pull request')
    })

    it('isolates cached fallback and rejects a late source A update after source B is selected', () => {
        const store = new TriageDetailSlotStore<object, { readonly revision: string }, string>()
        const sourceA = githubSource('github:octo/widgets')
        const sourceB: TriageDetailIdentity = {
            sourceContribution: {
                pluginId: '@happier-dev/plugins-scm-github',
                contributionId: 'scm-github-forge-items-secondary',
            },
            sourceInstanceId: 'github:octo/widgets',
            entryId: 'pull-request:42',
        }

        store.select({
            identity: sourceA,
            surface: { handle: 'github-detail' },
            input: { revision: 'source-a' },
        })
        expect(store.rememberFallback(sourceA, 'source-a cached body')).toBe(true)

        const selectedB = store.select({
            identity: sourceB,
            surface: { handle: 'github-secondary-detail' },
            input: { revision: 'source-b' },
        })

        expect(selectedB.cachedFallback).toBeUndefined()
        expect(store.rememberFallback(sourceA, 'late source-a body')).toBe(false)
        expect(store.current()).toBe(selectedB)

        const returnedA = store.select({
            identity: sourceA,
            surface: { handle: 'github-detail' },
            input: { revision: 'source-a-return' },
        })
        expect(returnedA.cachedFallback).toBe('source-a cached body')

        expect(createTriageDetailInstanceKey({
            ...sourceA,
            sourceContribution: {
                ...sourceA.sourceContribution,
                pluginId: '@happier-dev/plugins-scm-gitlab',
            },
        })).not.toBe(createTriageDetailInstanceKey(sourceA))
    })

    it('changes the mount key for a different source instance while preserving an exact return', () => {
        const store = new TriageDetailSlotStore<object, { readonly revision: string }, string>()
        const sourceA = githubSource('github:octo/widgets')
        const sourceASecondInstance = githubSource('github:octo/widgets-fork')

        const first = store.select({
            identity: sourceA,
            surface: { handle: 'github-detail' },
            input: { revision: 'source-a' },
        })
        expect(store.rememberFallback(sourceA, 'source-a cached body')).toBe(true)

        const secondInstance = store.select({
            identity: sourceASecondInstance,
            surface: { handle: 'github-fork-detail' },
            input: { revision: 'source-a-fork' },
        })

        expect(secondInstance.instanceKey).not.toBe(first.instanceKey)
        expect(secondInstance.cachedFallback).toBeUndefined()

        const returned = store.select({
            identity: sourceA,
            surface: { handle: 'github-detail' },
            input: { revision: 'source-a-return' },
        })
        expect(returned.instanceKey).toBe(first.instanceKey)
        expect(returned.cachedFallback).toBe('source-a cached body')
    })
})
