import { describe, expect, it, vi } from 'vitest'

import { fetchAndApplySessions } from './sessionsSnapshot'

describe('fetchAndApplySessions (/v2/sessions snapshot)', () => {
    it('pages through /v2/sessions and applies decrypted sessions', async () => {
        const previousUrl = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://example.test'

        const fetchSpy = vi.fn(async (input: any) => {
            const url = typeof input === 'string' ? input : String(input?.url ?? '')
            const parsed = new URL(url)
            expect(parsed.pathname).toBe('/v2/sessions')

            const cursor = parsed.searchParams.get('cursor')
            if (!cursor) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        sessions: [
                            {
                                id: 's2',
                                seq: 2,
                                createdAt: 2,
                                updatedAt: 2,
                                active: true,
                                activeAt: 2,
                                metadata: 'm2',
                                metadataVersion: 1,
                                agentState: null,
                                agentStateVersion: 0,
                                dataEncryptionKey: 'k2',
                                share: null,
                            },
                            {
                                id: 's1',
                                seq: 1,
                                createdAt: 1,
                                updatedAt: 1,
                                active: true,
                                activeAt: 1,
                                metadata: 'm1',
                                metadataVersion: 1,
                                agentState: null,
                                agentStateVersion: 0,
                                dataEncryptionKey: null,
                                share: { accessLevel: 'view', canApprovePermissions: true },
                            },
                        ],
                        nextCursor: 'cursor_v1_s1',
                        hasNext: true,
                    }),
                } as any
            }

            expect(cursor).toBe('cursor_v1_s1')
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    sessions: [
                        {
                            id: 's0',
                            seq: 0,
                            createdAt: 0,
                            updatedAt: 0,
                            active: false,
                            activeAt: 0,
                            metadata: 'm0',
                            metadataVersion: 1,
                            agentState: null,
                            agentStateVersion: 0,
                            dataEncryptionKey: 'k0',
                            share: null,
                        },
                    ],
                    nextCursor: null,
                    hasNext: false,
                }),
            } as any
        })

        vi.stubGlobal('fetch', fetchSpy as any)

        const decryptEncryptionKey = vi.fn(async (value: string) => new Uint8Array([value.length]))
        const initializeSessions = vi.fn(async () => {})
        const decryptMetadata = vi.fn(async () => ({ ok: true }))
        const decryptAgentState = vi.fn(async () => null)
        const getSessionEncryption = vi.fn(() => ({
            decryptMetadata,
            decryptAgentState,
        }))

        const applied: any[] = []
        const sessionDataKeys = new Map<string, Uint8Array>()

        await fetchAndApplySessions({
            credentials: { token: 't' } as any,
            encryption: {
                decryptEncryptionKey,
                initializeSessions,
                getSessionEncryption,
            },
            sessionDataKeys,
            applySessions: (sessions) => {
                applied.push(...sessions)
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        })

        expect(fetchSpy).toHaveBeenCalledTimes(2)

        expect(decryptEncryptionKey).toHaveBeenCalledTimes(2)
        expect(initializeSessions).toHaveBeenCalledTimes(1)

        expect(applied).toHaveLength(3)
        expect(applied.map((s) => s.id)).toEqual(['s2', 's1', 's0'])

        const shared = applied.find((s) => s.id === 's1')
        expect(shared.accessLevel).toBe('view')
        expect(shared.canApprovePermissions).toBe(true)

        expect(sessionDataKeys.has('s2')).toBe(true)
        expect(sessionDataKeys.has('s0')).toBe(true)
        expect(sessionDataKeys.has('s1')).toBe(false)

        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousUrl
        vi.unstubAllGlobals()
    })
})
