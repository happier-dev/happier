/**
 * SDK Metadata Extractor
 * Captures available tools and slash commands from Claude SDK initialization
 */

import { query } from './query'
import type { SDKSystemMessage } from './types'
import { logger } from '@/ui/logger'

export interface SDKMetadata {
    tools?: string[]
    slashCommands?: string[]
}

const DEFAULT_METADATA_EXTRACTION_TIMEOUT_MS = 10_000
const MIN_METADATA_EXTRACTION_TIMEOUT_MS = 10
const MAX_METADATA_EXTRACTION_TIMEOUT_MS = 120_000

function resolveMetadataExtractionTimeoutMs(): number {
    const raw = typeof process.env.HAPPIER_CLAUDE_SDK_METADATA_EXTRACTION_TIMEOUT_MS === 'string'
        ? process.env.HAPPIER_CLAUDE_SDK_METADATA_EXTRACTION_TIMEOUT_MS.trim()
        : ''
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return DEFAULT_METADATA_EXTRACTION_TIMEOUT_MS
    return Math.max(MIN_METADATA_EXTRACTION_TIMEOUT_MS, Math.min(MAX_METADATA_EXTRACTION_TIMEOUT_MS, parsed))
}

/**
 * Extract SDK metadata by running a minimal query and capturing the init message.
 *
 * Times out after the configured extraction timeout to prevent indefinite hangs
 * when the spawned SDK process blocks (e.g. on slow or inaccessible filesystems).
 *
 * @returns SDK metadata containing tools and slash commands
 */
export async function extractSDKMetadata(): Promise<SDKMetadata> {
    const abortController = new AbortController()
    const timeoutMs = resolveMetadataExtractionTimeoutMs()
    const timeoutId = setTimeout(() => {
        logger.debug(`[metadataExtractor] Extraction timed out after ${timeoutMs}ms`)
        abortController.abort()
    }, timeoutMs)
    if (typeof timeoutId.unref === 'function') {
        timeoutId.unref()
    }

    try {
        logger.debug('[metadataExtractor] Starting SDK metadata extraction')

        // Run SDK with minimal tools allowed
        const sdkQuery = query({
            prompt: 'hello',
            options: {
                allowedTools: ['Bash(echo)'],
                maxTurns: 1,
                abort: abortController.signal
            }
        })

        // Wait for the first system message which contains tools and slash commands
        for await (const message of sdkQuery) {
            if (message.type === 'system' && message.subtype === 'init') {
                const systemMessage = message as SDKSystemMessage

                const metadata: SDKMetadata = {
                    tools: systemMessage.tools,
                    slashCommands: systemMessage.slash_commands
                }

                logger.debug('[metadataExtractor] Captured SDK metadata:', metadata)

                // Abort the query since we got what we need
                abortController.abort()

                return metadata
            }
        }

        logger.debug('[metadataExtractor] No init message received from SDK')
        return {}

    } catch (error) {
        // Check if it's an abort error (expected — either from timeout or after capture)
        if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('[metadataExtractor] SDK query aborted (timeout or after capturing metadata)')
            return {}
        }
        logger.debug('[metadataExtractor] Error extracting SDK metadata:', error)
        return {}
    } finally {
        clearTimeout(timeoutId)
    }
}

/**
 * Extract SDK metadata asynchronously without blocking
 * Fires the extraction and updates metadata when complete
 */
export function extractSDKMetadataAsync(onComplete: (metadata: SDKMetadata) => void): void {
    extractSDKMetadata()
        .then(metadata => {
            if (metadata.tools || metadata.slashCommands) {
                onComplete(metadata)
            }
        })
        .catch(error => {
            logger.debug('[metadataExtractor] Async extraction failed:', error)
        })
}
