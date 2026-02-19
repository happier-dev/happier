import axios from 'axios'
import { logger } from '@/ui/logger'
import { Expo, ExpoPushMessage } from 'expo-server-sdk'
import { withServerUrlInPushData } from './pushNotificationData'
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog'
import { summarizeExpoPushTicketErrorsForLog } from './pushTicketLogSummary'
import { isPushDebugEnabled, readPushFetchTokensTimeoutMs } from './pushNotificationsConfig'

export interface PushToken {
    id: string
    token: string
    clientServerUrl?: string | null
    createdAt: number
    updatedAt: number
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


export class PushNotificationClient {
    private readonly token: string
    private readonly baseUrl: string
    private readonly expo: Expo

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

            if (debugPush) logger.debug(`Fetched ${response.data.tokens.length} push tokens`)
            
            // Log token information
            if (debugPush) {
                response.data.tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Token ${index + 1}: id=${token.id}, created=${new Date(token.createdAt).toISOString()}, updated=${new Date(token.updatedAt).toISOString()}`)
                })
            }
            
            return response.data.tokens
        } catch (error) {
            logger.debug('[PUSH] [ERROR] Failed to fetch push tokens:', serializeAxiosErrorForLog(error))
            throw new Error(`Failed to fetch push tokens: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
    }

    /**
     * Send push notification via Expo Push API with retry
     * @param messages - Array of push messages to send
     */
    async sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
        const debugPush = isPushDebugEnabled()
        if (debugPush) logger.debug(`Sending ${messages.length} push notifications`)

        // Filter out invalid push tokens
        const validMessages = messages.filter(message => {
            if (Array.isArray(message.to)) {
                return message.to.every(token => Expo.isExpoPushToken(token))
            }
            return Expo.isExpoPushToken(message.to)
        })

        if (validMessages.length === 0) {
            if (debugPush) logger.debug('No valid Expo push tokens found')
            return
        }

        // Create chunks to respect Expo's rate limits
        const chunks = this.expo.chunkPushNotifications(validMessages)

        for (const chunk of chunks) {
            // Retry with exponential backoff for 5 minutes
            const startTime = Date.now()
            const timeout = 300000 // 5 minutes
            let attempt = 0
            
            while (true) {
                try {
                    const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk)
                    
                    // Log any errors but don't throw
                    const errors = ticketChunk.filter(ticket => ticket.status === 'error')
                    if (errors.length > 0) {
                        logger.debug('[PUSH] Some notifications failed:', summarizeExpoPushTicketErrorsForLog(errors as any))
                    }
                    
                    // If all notifications failed, throw to trigger retry
                    if (errors.length === ticketChunk.length) {
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

            // Create messages for all tokens
            const messages: ExpoPushMessage[] = tokens.map((token, index) => {
                if (debugPush) logger.debug(`[PUSH] Creating message ${index + 1} for token`)
                const baseUrl = normalizeClientServerUrl(token.clientServerUrl) ?? this.baseUrl
                return {
                    to: token.token,
                    title,
                    body,
                    data: withServerUrlInPushData({ baseUrl, data }),
                    sound: 'default',
                    priority: 'high'
                }
            })

            // Send notifications
            if (debugPush) logger.debug(`[PUSH] Sending ${messages.length} push notifications...`)
            await this.sendPushNotifications(messages)
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
