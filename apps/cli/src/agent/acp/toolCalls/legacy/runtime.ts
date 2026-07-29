import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';
import {
    asRecord,
    extractTextFromContentBlock,
    extractToolInput,
    extractToolOutput,
} from '../../updates/content';
import type { SessionUpdate } from '../../updates/types';

import { AcpToolCallAccumulator } from '../AcpToolCallAccumulator';
import { buildAcpToolNameResolverInput } from '../toolNameResolverInput';
import { observeRawAcpToolUpdate, parseRawAcpToolUpdate } from '../observeRawToolUpdate';
import type {
    AcpToolAccumulatorEmission,
    AcpToolLifecycleStatus,
    MergedAcpToolCall,
    MergedAcpToolResult,
} from '../types';
import {
    projectLegacyAcpToolCallMessage,
    projectLegacyAcpToolResultMessage,
    readLegacyAcpToolResultValue,
} from './projectAgentMessages';
import { LegacyAcpSessionMediaPublisher } from './sessionMedia';

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;
const GENERIC_TOOL_NAMES = new Set(['', 'other', 'unknown', 'unknown_tool']);

function isGenericToolName(value: string): boolean {
    return GENERIC_TOOL_NAMES.has(value.trim().toLowerCase());
}

function inferGenericToolNameFromInput(input: unknown): string | null {
    if (!Array.isArray(input) || input.length === 0) return null;

    const parts: string[] = [];
    for (const item of input) {
        const text = extractTextFromContentBlock(item)
            ?? extractTextFromContentBlock(asRecord(item)?.content);
        if (text === null) return null;
        parts.push(text);
    }

    const text = parts.join('');
    return /^Command:\s*\S+/m.test(text) && /\bExit Code:\s*\d+/m.test(text)
        ? 'execute'
        : null;
}

export type LegacyAcpToolRuntimeOptions = Readonly<{
    sessionId: () => string;
    turnId: () => string;
    sidechainId: string | null;
    emit: (message: AgentMessage) => void;
    transport: TransportHandler;
    onBecameActive: () => void;
    onBecameIdle: () => void;
    onPublishedTerminalResult?: (result: MergedAcpToolResult) => void;
}>;

export class LegacyAcpToolRuntime {
    private readonly accumulator = new AcpToolCallAccumulator();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly permissionWaiting = new Set<string>();
    private readonly sessionMedia: LegacyAcpSessionMediaPublisher;
    private revision = 0;
    private disposed = false;

    constructor(private readonly options: LegacyAcpToolRuntimeOptions) {
        this.sessionMedia = new LegacyAcpSessionMediaPublisher(options.emit);
    }

    handleRawUpdate(updateValue: unknown): AcpToolAccumulatorEmission {
        this.assertActive();
        const parsedInput = parseRawAcpToolUpdate(updateValue);
        const turnId = this.resolveCorrelationTurnId(parsedInput);
        const extractedInput = extractToolInput(parsedInput as SessionUpdate);
        const extractedOutput = extractToolOutput(parsedInput as SessionUpdate);
        const knownBefore = this.readCallInTurn(parsedInput.toolCallId, turnId);
        const waiting = knownBefore ? this.permissionWaiting.has(knownBefore.localId) : false;
        const update = parseRawAcpToolUpdate({
            ...parsedInput,
            ...(Object.prototype.hasOwnProperty.call(parsedInput, 'rawInput') || extractedInput === undefined
                ? {}
                : { rawInput: extractedInput }),
            ...(Object.prototype.hasOwnProperty.call(parsedInput, 'rawOutput') || extractedOutput === undefined
                ? {}
                : { rawOutput: extractedOutput }),
            ...(waiting && parsedInput.status === 'in_progress' ? { status: 'pending' } : {}),
        });
        const known = this.readCallInTurn(update.toolCallId, turnId);
        const rawInput = Object.prototype.hasOwnProperty.call(update, 'rawInput')
            ? update.rawInput
            : known?.rawInput;
        const title = typeof update.title === 'string' ? update.title : known?.title;
        const inferenceInput = buildAcpToolNameResolverInput(rawInput, title);
        const knownSemanticName = known?.toolName && !isGenericToolName(known.toolName)
            ? known.toolName
            : null;
        const baseName = knownSemanticName
            ?? (typeof update.kind === 'string' && update.kind.trim()
                ? update.kind
                : this.options.transport.extractToolNameFromId?.(update.toolCallId)
                    ?? inferGenericToolNameFromInput(rawInput)
                    ?? 'other');
        const resolvedName = this.options.transport.determineToolName?.(
            baseName,
            update.toolCallId,
            inferenceInput,
            {
                recentPromptHadChangeTitle: false,
                toolCallCountSincePrompt: this.activeCalls().length + (known ? 0 : 1),
            },
        ) ?? baseName;
        const semanticName = isGenericToolName(resolvedName)
            && !isGenericToolName(baseName)
            ? baseName
            : resolvedName;
        const wasActive = this.activeCalls().length > 0;
        const emission = observeRawAcpToolUpdate({
            accumulator: this.accumulator,
            update,
            sessionId: this.options.sessionId(),
            turnId,
            sidechainId: this.options.sidechainId,
            revision: this.nextRevision(),
            observedAtMs: Date.now(),
            semanticName,
        });
        this.publish(emission);
        if (emission.kind !== 'ignored') this.updateOperationalState(emission.call);
        const isActive = this.activeCalls().length > 0;
        if (!wasActive && isActive) this.options.onBecameActive();
        if (wasActive && !isActive) this.options.onBecameIdle();
        return emission;
    }

    observePermission(params: Readonly<{
        toolCallId: string;
        toolName: string;
        input: Readonly<Record<string, unknown>>;
    }>): AcpToolAccumulatorEmission {
        this.assertActive();
        const wasActive = this.activeCalls().length > 0;
        const emission = this.accumulator.observe({
            sessionId: this.options.sessionId(),
            turnId: this.options.turnId(),
            sidechainId: this.options.sidechainId,
            toolCallId: params.toolCallId,
            revision: this.nextRevision(),
            observedAtMs: Date.now(),
            source: 'permission',
            semanticName: params.toolName,
            patch: { status: 'pending', rawInput: params.input },
        });
        this.publish(emission);
        if (emission.kind !== 'ignored') {
            this.clearTimer(emission.call.localId);
            this.permissionWaiting.add(emission.call.localId);
        }
        if (!wasActive && this.activeCalls().length > 0) this.options.onBecameActive();
        return emission;
    }

    markWaitingForPermission(toolCallId: string): void {
        const call = this.readCall(toolCallId);
        if (!call) return;
        this.clearTimer(call.localId);
        this.permissionWaiting.add(call.localId);
        this.observeStatus(call, 'pending');
    }

    markRunningAfterPermission(toolCallId: string): void {
        const call = this.readCall(toolCallId);
        if (!call) return;
        this.permissionWaiting.delete(call.localId);
        const emission = this.observeStatus(call, 'running');
        if (emission.kind !== 'ignored') this.armTimer(emission.call);
    }

    terminalizeCall(toolCallId: string, status: Extract<AcpToolLifecycleStatus, 'completed' | 'failed' | 'cancelled'>): void {
        const call = this.readCall(toolCallId);
        if (!call) return;
        const emission = this.accumulator.observe({
            sessionId: call.sessionId,
            turnId: call.turnId,
            sidechainId: call.sidechainId,
            toolCallId: call.toolCallId,
            revision: this.nextRevision(),
            observedAtMs: Date.now(),
            source: 'terminalize_turn',
            patch: { status },
        });
        this.publish(emission);
        this.clearOperationalState(call.localId);
    }

    terminalizeTurn(status: Extract<AcpToolLifecycleStatus, 'completed' | 'failed' | 'cancelled'>): void {
        const wasActive = this.activeCalls().length > 0;
        const emissions = this.accumulator.terminalizeTurn({
            sessionId: this.options.sessionId(),
            turnId: this.options.turnId(),
            sidechainId: this.options.sidechainId,
            status,
            revision: this.nextRevision(),
            observedAtMs: Date.now(),
        });
        for (const emission of emissions) {
            this.publish(emission);
            if (emission.kind !== 'ignored') this.clearOperationalState(emission.call.localId);
        }
        if (wasActive && this.activeCalls().length === 0) this.options.onBecameIdle();
    }

    activeCalls(): readonly MergedAcpToolCall[] {
        return this.accumulator.listActiveCalls({
            sessionId: this.options.sessionId(),
            turnId: this.options.turnId(),
            sidechainId: this.options.sidechainId,
        });
    }

    readCall(toolCallId: string): MergedAcpToolCall | null {
        return this.readCallInTurn(toolCallId, this.options.turnId());
    }

    diagnostics(): Readonly<{
        active: number;
        tombstones: number;
        closedTurns: number;
        timers: number;
        permissionWaiters: number;
        mediaFingerprints: number;
    }> {
        return Object.freeze({
            active: this.accumulator.activeSize,
            tombstones: this.accumulator.tombstoneSize,
            closedTurns: this.accumulator.closedTurnSize,
            timers: this.timers.size,
            permissionWaiters: this.permissionWaiting.size,
            mediaFingerprints: this.sessionMedia.size,
        });
    }

    reset(): void {
        this.clearTimers();
        this.permissionWaiting.clear();
        this.sessionMedia.reset();
        this.accumulator.reset();
    }

    dispose(): void {
        if (this.disposed) return;
        this.clearTimers();
        this.permissionWaiting.clear();
        this.sessionMedia.reset();
        this.accumulator.dispose();
        this.disposed = true;
    }

    private observeStatus(call: MergedAcpToolCall, status: string): AcpToolAccumulatorEmission {
        const emission = this.accumulator.observe({
            sessionId: call.sessionId,
            turnId: call.turnId,
            sidechainId: call.sidechainId,
            toolCallId: call.toolCallId,
            revision: this.nextRevision(),
            observedAtMs: Date.now(),
            source: 'permission',
            patch: { status },
        });
        this.publish(emission);
        return emission;
    }

    private updateOperationalState(call: MergedAcpToolCall): void {
        if (call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled') {
            this.clearOperationalState(call.localId);
            return;
        }
        if (call.status === 'running') this.armTimer(call);
        else this.clearTimer(call.localId);
    }

    private armTimer(call: MergedAcpToolCall): void {
        this.clearTimer(call.localId);
        const configured = this.options.transport.getToolCallTimeout?.(call.toolCallId, call.kind);
        const timeoutMs = configured === undefined ? DEFAULT_TOOL_CALL_TIMEOUT_MS : configured;
        if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
        const timer = setTimeout(() => {
            this.timers.delete(call.localId);
            const current = this.readCall(call.toolCallId);
            if (!current || current.status !== 'running') return;
            const emission = this.accumulator.observe({
                sessionId: current.sessionId,
                turnId: current.turnId,
                sidechainId: current.sidechainId,
                toolCallId: current.toolCallId,
                revision: this.nextRevision(),
                observedAtMs: Date.now(),
                source: 'terminalize_turn',
                patch: {
                    status: 'failed',
                    error: {
                        error: `Tool call timed out after ${(timeoutMs / 1_000).toFixed(0)}s`,
                        status: 'timeout',
                        timeoutMs,
                    },
                },
            });
            this.publish(emission);
            if (emission.kind !== 'ignored') this.clearOperationalState(emission.call.localId);
            if (this.activeCalls().length === 0) this.options.onBecameIdle();
        }, Math.trunc(timeoutMs));
        timer.unref?.();
        this.timers.set(call.localId, timer);
    }

    private publish(emission: AcpToolAccumulatorEmission): void {
        if (emission.kind === 'ignored') return;
        this.options.emit(projectLegacyAcpToolCallMessage(emission.call));
        if (emission.kind !== 'progress' && emission.publishResult && emission.result) {
            const value = readLegacyAcpToolResultValue(emission.result);
            const callKind = emission.call.kind ?? null;
            this.options.emit(projectLegacyAcpToolResultMessage(emission.result, callKind, value));
            this.sessionMedia.publish(emission.result, value, callKind);
            if (emission.kind === 'terminal') {
                this.options.onPublishedTerminalResult?.(emission.result);
            }
        }
    }

    private resolveCorrelationTurnId(update: ReturnType<typeof parseRawAcpToolUpdate>): string {
        const currentTurnId = this.options.turnId();
        if (update.sessionUpdate !== 'tool_call_update') {
            return currentTurnId;
        }
        if (this.readCallInTurn(update.toolCallId, currentTurnId)) {
            return currentTurnId;
        }
        return this.accumulator.findNewestRetainedTurnId({
            sessionId: this.options.sessionId(),
            sidechainId: this.options.sidechainId,
            toolCallId: update.toolCallId,
        }) ?? currentTurnId;
    }

    private readCallInTurn(toolCallId: string, turnId: string): MergedAcpToolCall | null {
        return this.accumulator.peek(
            this.options.sessionId(),
            turnId,
            this.options.sidechainId,
            toolCallId,
        );
    }

    private clearTimer(localId: string): void {
        const timer = this.timers.get(localId);
        if (!timer) return;
        clearTimeout(timer);
        this.timers.delete(localId);
    }

    private clearOperationalState(localId: string): void {
        this.clearTimer(localId);
        this.permissionWaiting.delete(localId);
    }

    private clearTimers(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    private nextRevision(): number {
        return this.revision++;
    }

    private assertActive(): void {
        if (this.disposed) throw new Error('Legacy ACP tool runtime is disposed');
    }
}
