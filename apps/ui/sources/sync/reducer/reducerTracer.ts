// ============================================================================
// Reducer Tracer - Message Relationship Tracking for Sidechains
// ============================================================================
//
// This module is responsible for tracking relationships between messages,
// specifically focusing on linking sidechain messages to their originating
// Task tool calls. This is crucial for understanding the flow of AI agent
// interactions where Task tools spawn separate execution contexts (sidechains).
//
// Key Concepts:
// -------------
// 1. Task Tools: When the AI uses a Task tool, it initiates a separate
//    execution context that produces its own message stream (a sidechain).
//
// 2. Sidechains: These are message sequences that occur in a separate context
//    but need to be linked back to the Task that spawned them. Messages in
//    sidechains have isSidechain=true.
//
// 3. Message Relationships: Each message can have:
//    - A UUID: Unique identifier for the message
//    - A parentUUID: Reference to its parent message (for nested responses)
//    - A sidechainId: The tool-call id of the Task tool call that spawned it
//
// How It Works:
// -------------
// 1. Task Detection: When a Task tool call is encountered, we store it in
//    taskTools indexed by the message ID. We also index by prompt to the
//    Task tool-call id for quick lookup when matching sidechain roots.
//
// 2. Sidechain Root Matching: When a sidechain message arrives with a prompt
//    that matches a known Task prompt, it's identified as a sidechain root
//    and assigned the Task tool-call id as its sidechainId.
//
//    Provider-agnostic override: if a message already carries a `sidechainId`,
//    we treat it as authoritative and do not rely on prompt matching.
//
// 3. Parent-Child Linking: Sidechain messages can reference parent messages
//    via parentUUID. Children inherit the sidechainId from their parent.
//
// 4. Orphan Handling: Messages may arrive out of order. If a child arrives
//    before its parent, it's buffered as an "orphan" until the parent
//    arrives, then processed recursively.
//
// 5. Propagation: Once a sidechain root is identified, all its descendants
//    (direct children and their children) inherit the same sidechainId.
//
// Example Flow:
// -------------
// 1. Message "msg1" contains Task tool call with prompt "Search for files"
// 2. Sidechain message "sc1" arrives with type="sidechain" and same prompt
//    -> sc1 gets sidechainId="<task tool-call id>"
// 3. Message "sc2" arrives with parentUUID="sc1"
//    -> sc2 inherits sidechainId="<task tool-call id>" from its parent
// 4. Any orphans waiting for "sc1" or "sc2" are processed recursively
//
// This tracking enables the UI to group related messages together and show
// the complete context of Task executions, even when messages arrive out
// of order or from different execution contexts.
//
// ============================================================================

import { NormalizedMessage } from '../typesRaw';

type OrphanBucket = {
    updatedAt: number;
    messages: NormalizedMessage[];
};

function normalizePromptKey(prompt: string): string {
    return String(prompt ?? '').trim();
}

function promptOrphanKey(promptKey: string): string {
    return `__prompt__:${promptKey}`;
}

const ORPHAN_TTL_MS = 10 * 60_000;
const MAX_ORPHANS_PER_PARENT = 50;
const MAX_TOTAL_ORPHANS = 500;

// Extended message type with sidechain ID for tracking message relationships
export type TracedMessage = NormalizedMessage & {
    sidechainId?: string;  // ID of the Task tool-call that initiated this sidechain
}

// Tracer state for tracking message relationships and sidechain processing
export interface TracerState {
    // Task tracking - stores Task tool calls by their message ID
    taskTools: Map<string, { toolCallId: string; prompt: string }>;  // messageId -> Task info
    promptToTaskId: Map<string, string>;  // prompt -> task tool-call ID (for matching sidechains)
    
    // Sidechain tracking - maps message UUIDs to their originating Task tool-call ID
    uuidToSidechainId: Map<string, string>;  // uuid -> sidechain ID (originating task tool-call ID)
    
    // Buffering for out-of-order messages that arrive before their parent
    orphanMessages: Map<string, OrphanBucket>;  // parentUuid -> orphan messages waiting for parent
    
    // Track already processed messages to avoid duplicates
    processedIds: Set<string>;
}

// Create a new tracer state with empty collections
export function createTracer(): TracerState {
    return {
        taskTools: new Map(),
        promptToTaskId: new Map(),
        uuidToSidechainId: new Map(),
        orphanMessages: new Map(),
        processedIds: new Set()
    };
}

function pruneOrphans(state: TracerState, now = Date.now()): void {
    // TTL eviction.
    for (const [parentUuid, bucket] of state.orphanMessages) {
        if (now - bucket.updatedAt > ORPHAN_TTL_MS) {
            state.orphanMessages.delete(parentUuid);
        }
    }

    let total = 0;
    for (const bucket of state.orphanMessages.values()) {
        total += bucket.messages.length;
    }

    if (total <= MAX_TOTAL_ORPHANS) return;

    // Global cap: drop oldest buckets first.
    const buckets = [...state.orphanMessages.entries()]
        .map(([parentUuid, bucket]) => ({ parentUuid, updatedAt: bucket.updatedAt, count: bucket.messages.length }))
        .sort((a, b) => a.updatedAt - b.updatedAt);

    for (const bucket of buckets) {
        if (total <= MAX_TOTAL_ORPHANS) break;
        state.orphanMessages.delete(bucket.parentUuid);
        total -= bucket.count;
    }
}

function addOrphan(state: TracerState, parentUuid: string, message: NormalizedMessage): void {
    const now = Date.now();
    pruneOrphans(state, now);

    const bucket = state.orphanMessages.get(parentUuid) ?? { updatedAt: now, messages: [] };
    bucket.updatedAt = now;
    bucket.messages.push(message);
    if (bucket.messages.length > MAX_ORPHANS_PER_PARENT) {
        bucket.messages.splice(0, bucket.messages.length - MAX_ORPHANS_PER_PARENT);
    }
    state.orphanMessages.set(parentUuid, bucket);

    pruneOrphans(state, now);
}

// Extract UUID from the first content item of an agent message
function getMessageUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('uuid' in firstContent && firstContent.uuid) {
            return firstContent.uuid;
        }
    }
    return null;
}

// Extract parent UUID from the first content item of an agent message
function getParentUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('parentUUID' in firstContent) {
            return firstContent.parentUUID;
        }
    }
    return null;
}

// Process orphan messages recursively when their parent becomes available
function processOrphans(state: TracerState, parentUuid: string, sidechainId: string): TracedMessage[] {
    const results: TracedMessage[] = [];
    const bucket = state.orphanMessages.get(parentUuid);
    
    if (!bucket) {
        return results;
    }
    
    // Remove from orphan map
    state.orphanMessages.delete(parentUuid);
    
    // Process each orphan
    for (const orphan of bucket.messages) {
        const uuid = getMessageUuid(orphan);
        
        // Mark as processed
        state.processedIds.add(orphan.id);
        
        // Assign sidechain ID
        if (uuid) {
            state.uuidToSidechainId.set(uuid, sidechainId);
        }
        
        // Create traced message
        const tracedMessage: TracedMessage = {
            ...orphan,
            sidechainId
        };
        results.push(tracedMessage);
        
        // Recursively process any orphans waiting for this message
        if (uuid) {
            const childOrphans = processOrphans(state, uuid, sidechainId);
            results.push(...childOrphans);
        }
    }
    
    return results;
}

// Main tracer function - processes messages and assigns sidechain IDs based on Task relationships
export function traceMessages(state: TracerState, messages: NormalizedMessage[]): TracedMessage[] {
    const results: TracedMessage[] = [];
    pruneOrphans(state);
    
    for (const message of messages) {
        // Skip if already processed
        if (state.processedIds.has(message.id)) {
            continue;
        }
        
        // Extract Task tools and index them by message ID for later sidechain matching
        if (message.role === 'agent') {
            for (const content of message.content) {
                if (content.type === 'tool-call' && content.name === 'Task') {
                    if (content.input && typeof content.input === 'object' && 'prompt' in content.input) {
                        const toolCallId =
                            typeof content.id === 'string' && content.id ? content.id : message.id;
                        if (!toolCallId) continue;
                        const prompt = (content.input as any).prompt;
                        if (typeof prompt !== 'string' || !prompt) continue;
                        const promptKey = normalizePromptKey(prompt);
                        if (!promptKey) continue;
                        // Store Task info indexed by message ID (and map prompt -> tool-call id).
                        state.taskTools.set(message.id, {
                            toolCallId,
                            prompt: promptKey
                        });
                        state.promptToTaskId.set(promptKey, toolCallId);

                        // Flush any buffered sidechain roots that arrived before this Task tool-call.
                        results.push(...processOrphans(state, promptOrphanKey(promptKey), toolCallId));
                    }
                }
            }
        }

        const uuid = getMessageUuid(message);
        const parentUuid = getParentUuid(message);
        const explicitSidechainId = typeof message.sidechainId === 'string' && message.sidechainId.trim().length > 0
            ? message.sidechainId
            : undefined;
        const inferredFromParent = parentUuid ? state.uuidToSidechainId.get(parentUuid) : undefined;
        const shouldTreatAsSidechain = message.isSidechain || Boolean(explicitSidechainId) || Boolean(inferredFromParent);
        
        // Non-sidechain messages are returned immediately without sidechain ID.
        // Fallbacks:
        // - explicit sidechainId from provider metadata
        // - parent already mapped to a sidechain (when isSidechain flag is missing)
        if (!shouldTreatAsSidechain) {
            state.processedIds.add(message.id);
            const tracedMessage: TracedMessage = {
                ...message
            };
            results.push(tracedMessage);
            continue;
        }

        // Handle sidechain messages - these need to be linked to their originating Task.
        // Provider-agnostic: prefer explicit sidechainId if present on the message.
        let isSidechainRoot = false;
        let sidechainId: string | undefined = explicitSidechainId;
        let pendingPromptKey: string | null = null;
        
        // If not provided explicitly, look for sidechain content type with a prompt that matches a Task.
        if (!sidechainId && message.role === 'agent') {
            for (const content of message.content) {
                if (content.type === 'sidechain' && content.prompt) {
                    const promptKey = normalizePromptKey(content.prompt);
                    if (!promptKey) continue;
                    const taskId = state.promptToTaskId.get(promptKey);
                    if (taskId) {
                        isSidechainRoot = true;
                        sidechainId = taskId;
                        break;
                    }
                    // Sidechain root arrived before the Task tool-call: buffer it by prompt.
                    pendingPromptKey = promptKey;
                }
            }
        }
        
        if ((explicitSidechainId || isSidechainRoot) && sidechainId) {
            // This is a sidechain root - mark it and process any waiting orphans
            state.processedIds.add(message.id);
            if (uuid) {
                state.uuidToSidechainId.set(uuid, sidechainId);
            }
            
            const tracedMessage: TracedMessage = {
                ...message,
                sidechainId
            };
            results.push(tracedMessage);
            
            // Process any orphan messages that were waiting for this parent
            if (uuid) {
                const orphanResults = processOrphans(state, uuid, sidechainId);
                results.push(...orphanResults);
            }
        } else if (parentUuid) {
            // This message has a parent - check if parent's sidechain ID is known
            const parentSidechainId = state.uuidToSidechainId.get(parentUuid);
            
            if (parentSidechainId) {
                // Parent is known - inherit the same sidechain ID
                state.processedIds.add(message.id);
                if (uuid) {
                    state.uuidToSidechainId.set(uuid, parentSidechainId);
                }
                
                const tracedMessage: TracedMessage = {
                    ...message,
                    sidechainId: parentSidechainId
                };
                results.push(tracedMessage);
                
                // Process any orphans waiting for this UUID
                if (uuid) {
                    const orphanResults = processOrphans(state, uuid, parentSidechainId);
                    results.push(...orphanResults);
                }
            } else {
                // Parent not yet processed - buffer this message as an orphan
                addOrphan(state, parentUuid, message);
            }
        } else {
            // Sidechain message with no parent and not a root:
            // - If it's a sidechain root with a prompt, buffer until the Task tool-call arrives.
            // - Otherwise drop it to avoid leaking sidechain tool execution into the main transcript.
            if (pendingPromptKey) {
                addOrphan(state, promptOrphanKey(pendingPromptKey), message);
            } else {
                state.processedIds.add(message.id);
            }
        }
    }
    
    return results;
}
