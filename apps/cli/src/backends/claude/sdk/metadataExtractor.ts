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

/** Maximum time to wait for SDK metadata extraction before giving up. */
const METADATA_EXTRACTION_TIMEOUT_MS = 10_000

/**
 * Extract SDK metadata by running a minimal query and capturing the init message.
 *
 * Times out after METADATA_EXTRACTION_TIMEOUT_MS to prevent indefinite hangs
 * when the spawned SDK process blocks (e.g. on slow or inaccessible filesystems).
 *
 * @returns SDK metadata containing tools and slash commands
 */
export async function extractSDKMetadata(): Promise<SDKMetadata> {
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => {
        logger.debug(`[metadataExtractor] Extraction timed out after ${METADATA_EXTRACTION_TIMEOUT_MS}ms`)
        abortController.abort()
    }, METADATA_EXTRACTION_TIMEOUT_MS)

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
                clearTimeout(timeoutId)
                abortController.abort()

                return metadata
            }
        }

        clearTimeout(timeoutId)
        logger.debug('[metadataExtractor] No init message received from SDK')
        return {}

    } catch (error) {
        clearTimeout(timeoutId)
        // Check if it's an abort error (expected — either from timeout or after capture)
        if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('[metadataExtractor] SDK query aborted (timeout or after capturing metadata)')
            return {}
        }
        logger.debug('[metadataExtractor] Error extracting SDK metadata:', error)
        return {}
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
