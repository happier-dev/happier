import axios from 'axios'
import { logger } from '@/ui/logger'
import { Expo, ExpoPushMessage } from 'expo-server-sdk'
import { withServerUrlInPushData } from './pushNotificationData'
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog'
import { summarizeExpoPushTicketErrorsForLog } from './pushTicketLogSummary'
import {
    isPushDebugEnabled,
    readPushFetchTokensFailureCooldownMs,
    readPushFetchTokensTimeoutMs,
} from './pushNotificationsConfig'
import {
    collectExpoPushTokensMarkedUnregistered,
    PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
    PUSH_NOTIFICATION_CATEGORY_IDS,
} from '@happier-dev/protocol'

export interface PushToken {
    id: string
    token: string
    clientServerUrl?: string | null
    createdAt: number
    updatedAt: number
}

interface AccountActivityBadgeSnapshotResponse {
    badgeCount: number
}

function normalizeClientServerUrl(raw: unknown): string | null {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) return null
    try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString().replace(/\/+$/, '')
    } catch {
        return null
    }
}

type PushRequestKind = 'permission' | 'user_action'

function resolvePushRequestKindFromPushData(data: Record<string, unknown> | undefined): PushRequestKind | null {
    const kind = typeof data?.kind === 'string' ? data.kind.trim() : ''
    if (kind === 'permission' || kind === 'user_action') return kind

    const type = typeof data?.type === 'string' ? data.type.trim() : ''
    if (type === 'permission_request') return 'permission'
    if (type === 'user_action_request') return 'user_action'
    return null
}

function resolveCategoryIdFromPushData(data: Record<string, unknown> | undefined): string | undefined {
    const kind = resolvePushRequestKindFromPushData(data)
    if (kind === 'permission') return PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1
    if (kind === 'user_action') return PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1
    return undefined
}

function resolveAndroidChannelIdFromPushData(data: Record<string, unknown> | undefined): string | undefined {
    const kind = resolvePushRequestKindFromPushData(data)
    if (kind === 'permission') return PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1
    if (kind === 'user_action') return PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1
    return undefined
}

function sanitizeNotificationSubtitle(raw: string): string {
    const value = String(raw ?? '').trim()
    if (!value) return ''
    // Avoid newlines/control chars in lock screen notifications; also cap length for safety.
    const collapsed = value
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (!collapsed) return ''
    return collapsed.length > 80 ? collapsed.slice(0, 80) : collapsed
}

function resolveIosSubtitleFromPushData(data: Record<string, unknown> | undefined): string | undefined {
    const categoryId = resolveCategoryIdFromPushData(data)
    if (!categoryId) return undefined
    const tool = typeof data?.tool === 'string' ? sanitizeNotificationSubtitle(data.tool) : ''
    return tool ? tool : undefined
}

export class PushNotificationClient {
    private readonly token: string
    private readonly baseUrl: string
    private readonly expo: Expo
    private pushTokenFetchFailureCooldownUntilMs = 0
    private didLogPushTokenFetchCooldown = false

    constructor(token: string, baseUrl: string = 'https://api.happier.dev') {
        this.token = token
        this.baseUrl = baseUrl
        this.expo = new Expo()
    }

    /**
     * Fetch all push tokens for the authenticated user
     */
    async fetchPushTokens(): Promise<PushToken[]> {
        const debugPush = isPushDebugEnabled()
        const nowMs = Date.now()
        if (this.pushTokenFetchFailureCooldownUntilMs > nowMs) {
            if (!this.didLogPushTokenFetchCooldown) {
                logger.debug('[PUSH] Skipping push token fetch during failure cooldown', {
                    remainingMs: this.pushTokenFetchFailureCooldownUntilMs - nowMs,
                })
                this.didLogPushTokenFetchCooldown = true
            }
            return []
        }
        try {
            const response = await axios.get<{ tokens: PushToken[] }>(
                `${this.baseUrl}/v1/push-tokens`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: readPushFetchTokensTimeoutMs(),
                }
            )

            this.pushTokenFetchFailureCooldownUntilMs = 0
            this.didLogPushTokenFetchCooldown = false

            if (debugPush) logger.debug(`Fetched ${response.data.tokens.length} push tokens`)
            
            // Log token information
            if (debugPush) {
                response.data.tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Token ${index + 1}: id=${token.id}, created=${new Date(token.createdAt).toISOString()}, updated=${new Date(token.updatedAt).toISOString()}`)
                })
            }
            
            return response.data.tokens
        } catch (error) {
            const cooldownMs = readPushFetchTokensFailureCooldownMs()
            this.pushTokenFetchFailureCooldownUntilMs = cooldownMs > 0 ? Date.now() + cooldownMs : 0
            this.didLogPushTokenFetchCooldown = false
            logger.debug('[PUSH] [ERROR] Failed to fetch push tokens:', serializeAxiosErrorForLog(error))
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : typeof (error as { message?: unknown } | null | undefined)?.message === 'string'
                        ? String((error as { message: string }).message)
                        : 'Unknown error'
            throw new Error(`Failed to fetch push tokens: ${errorMessage}`)
        }
    }

    async fetchAccountActivityBadgeCount(): Promise<number | null> {
        const debugPush = isPushDebugEnabled()
        try {
            const response = await axios.get<AccountActivityBadgeSnapshotResponse>(
                `${this.baseUrl}/v1/account/activity/badge-snapshot`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: readPushFetchTokensTimeoutMs(),
                }
            )

            const badgeCount = Number.isInteger(response.data?.badgeCount) && response.data.badgeCount >= 0
                ? response.data.badgeCount
                : null
            if (debugPush) logger.debug(`[PUSH] Fetched badge snapshot count: ${badgeCount ?? 'null'}`)
            return badgeCount
        } catch (error) {
            logger.debug('[PUSH] Failed to fetch badge snapshot:', serializeAxiosErrorForLog(error))
            return null
        }
    }

    async deletePushToken(token: string): Promise<void> {
        await axios.delete(
            `${this.baseUrl}/v1/push-tokens/${encodeURIComponent(token)}`,
            {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: readPushFetchTokensTimeoutMs(),
            }
        )
    }

    async deletePushTokens(tokens: ReadonlyArray<string>): Promise<void> {
        const uniqueTokens = [...new Set(tokens.filter((token): token is string => typeof token === 'string' && token.trim().length > 0))]
        if (uniqueTokens.length === 0) return

        const debugPush = isPushDebugEnabled()
        const results = await Promise.allSettled(uniqueTokens.map((token) => this.deletePushToken(token)))
        for (const [index, result] of results.entries()) {
            if (result.status === 'fulfilled') continue
            logger.debug('[PUSH] Failed to delete invalid push token:', {
                tokenIndex: index,
                total: uniqueTokens.length,
                error: serializeAxiosErrorForLog(result.reason),
            })
        }
        if (debugPush) logger.debug(`[PUSH] Deleted ${results.filter((result) => result.status === 'fulfilled').length} invalid push token(s)`)
    }

    /**
     * Send push notification via Expo Push API with retry
     * @param messages - Array of push messages to send
     */
    async sendPushNotifications(messages: ExpoPushMessage[]): Promise<Readonly<{ invalidTokens: ReadonlyArray<string> }>> {
        const debugPush = isPushDebugEnabled()
        if (debugPush) logger.debug(`Sending ${messages.length} push notifications`)
        const invalidTokens = new Set<string>()

        // Filter out invalid push tokens
        const validMessages = messages.filter(message => {
            if (Array.isArray(message.to)) {
                return message.to.every(token => Expo.isExpoPushToken(token))
            }
            return Expo.isExpoPushToken(message.to)
        })

        if (validMessages.length === 0) {
            if (debugPush) logger.debug('No valid Expo push tokens found')
            return { invalidTokens: [] }
        }

        // Create chunks to respect Expo's rate limits
        const chunks = this.expo.chunkPushNotifications(validMessages)

        for (const chunk of chunks) {
            // Retry with exponential backoff for 5 minutes
            const startTime = Date.now()
            const timeout = 300000 // 5 minutes
            let attempt = 0
            let retryChunk = [...chunk]
            
            while (true) {
                try {
                    const ticketChunk = await this.expo.sendPushNotificationsAsync(retryChunk)
                    let receipts: Record<string, unknown> | undefined
                    const receiptIds = ticketChunk
                        .map((ticket) => typeof (ticket as { id?: unknown })?.id === 'string' ? (ticket as { id: string }).id : null)
                        .filter((ticketId): ticketId is string => typeof ticketId === 'string' && ticketId.length > 0)

                    if (receiptIds.length > 0) {
                        try {
                            receipts = await this.expo.getPushNotificationReceiptsAsync(receiptIds)
                        } catch (error) {
                            logger.debug('[PUSH] Failed to fetch Expo push receipts:', serializeAxiosErrorForLog(error))
                        }
                    }

                    const chunkInvalidTokens = collectExpoPushTokensMarkedUnregistered({
                        messages: retryChunk,
                        tickets: ticketChunk,
                        receipts,
                    })
                    for (const token of chunkInvalidTokens) {
                        invalidTokens.add(token)
                    }
                    if (chunkInvalidTokens.length > 0) {
                        const deadTokens = new Set(chunkInvalidTokens)
                        retryChunk = retryChunk.filter((message) => {
                            if (Array.isArray(message.to)) {
                                return message.to.some((token) => !deadTokens.has(token))
                            }
                            return !deadTokens.has(message.to)
                        })
                    }
                    
                    // Log any errors but don't throw
                    const errors = ticketChunk.filter(ticket => ticket.status === 'error')
                    if (errors.length > 0) {
                        logger.debug('[PUSH] Some notifications failed:', summarizeExpoPushTicketErrorsForLog(errors as any))
                    }
                    
                    // If all notifications failed, throw to trigger retry
                    if (errors.length === ticketChunk.length) {
                        if (retryChunk.length === 0) {
                            if (debugPush) {
                                logger.debug('[PUSH] Not retrying terminal DeviceNotRegistered failures')
                            }
                            break
                        }
                        throw new Error('All push notifications in chunk failed')
                    }
                    
                    // Success - break out of retry loop
                    break
                } catch (error) {
                    const elapsed = Date.now() - startTime
                    if (elapsed >= timeout) {
                        if (debugPush) logger.debug('[PUSH] Timeout reached after 5 minutes, giving up on chunk')
                        break
                    }
                    
                    // Calculate exponential backoff delay
                    attempt++
                    const delay = Math.min(1000 * Math.pow(2, attempt), 30000) // Max 30 seconds between retries
                    const remainingTime = timeout - elapsed
                    const waitTime = Math.min(delay, remainingTime)
                    
                    if (waitTime > 0) {
                        if (debugPush) logger.debug(`[PUSH] Retrying in ${waitTime}ms (attempt ${attempt})`)
                        await new Promise(resolve => setTimeout(resolve, waitTime))
                    }
                }
            }
        }

        if (debugPush) logger.debug(`Push notifications sent successfully`)
        return { invalidTokens: [...invalidTokens] }
    }

    /**
     * Send a push notification to all registered devices for the user
     * @param title - Notification title
     * @param body - Notification body
     * @param data - Additional data to send with the notification
     */
    async sendToAllDevicesAsync(title: string, body: string, data?: Record<string, any>): Promise<void> {
        const debugPush = isPushDebugEnabled()
        if (debugPush) logger.debug(`[PUSH] sendToAllDevicesAsync called with title: "${title}", body: "${body}"`);

        try {
            // Fetch all push tokens
            if (debugPush) logger.debug('[PUSH] Fetching push tokens...')
            const tokens = await this.fetchPushTokens()
            if (debugPush) logger.debug(`[PUSH] Fetched ${tokens.length} push tokens`)

            // Log token details for debugging
            if (debugPush) {
                tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Using token ${index + 1}: id=${token.id}`)
                })
            }

            if (tokens.length === 0) {
                if (debugPush) logger.debug('No push tokens found for user')
                return
            }

            const badgeCount = await this.fetchAccountActivityBadgeCount()

            // Create messages for all tokens
            const messages: ExpoPushMessage[] = tokens.map((token, index) => {
                if (debugPush) logger.debug(`[PUSH] Creating message ${index + 1} for token`)
                const baseUrl = normalizeClientServerUrl(token.clientServerUrl) ?? this.baseUrl
                const categoryId = resolveCategoryIdFromPushData(data);
                const channelId = resolveAndroidChannelIdFromPushData(data);
                const subtitle = resolveIosSubtitleFromPushData(data);
                return {
                    to: token.token,
                    title,
                    body,
                    data: withServerUrlInPushData({ baseUrl, data }),
                    sound: 'default',
                    priority: 'high',
                    categoryId,
                    channelId,
                    subtitle,
                    badge: badgeCount ?? undefined,
                }
            })

            // Send notifications
            if (debugPush) logger.debug(`[PUSH] Sending ${messages.length} push notifications...`)
            const sendResult = await this.sendPushNotifications(messages)
            await this.deletePushTokens(sendResult.invalidTokens)
            if (debugPush) logger.debug('[PUSH] Push notifications sent successfully')
        } catch (error) {
            logger.debug('[PUSH] Error sending to all devices:', serializeAxiosErrorForLog(error))
            throw error
        }
    }

    sendToAllDevices(title: string, body: string, data?: Record<string, any>): void {
        void this.sendToAllDevicesAsync(title, body, data).catch(() => {});
    }
}
