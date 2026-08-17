import { readFile } from 'node:fs/promises';

import * as protocol from '@happier-dev/protocol';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PluginOperationAvailability } from '../availability.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue } from '../identity.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type {
    ExternalSessionAgentId,
    ExternalSessionAttachResult,
    ExternalSessionCandidateRecord,
    ExternalSessionListPage,
    ExternalSessionListQuery,
    ExternalSessionMaterializeActionResult,
    ExternalSessionOperationActionResult,
    ExternalSessionOperationPresentation,
    ExternalSessionOperationReference,
    ExternalSessionReadAfterDiagnostic,
    ExternalSessionRef,
    ExternalSessionsCapabilities,
    ExternalSessionsService,
    ExternalSessionSourceId,
    ExternalSessionTakeoverCapability,
    ExternalSessionTakeoverIdempotencyKey,
    ExternalSessionTakeoverRequest,
    ExternalSessionTranscriptFollowEvent,
    ExternalSessionTranscriptFollowOptions,
    ExternalSessionTranscriptFollowResult,
    ExternalSessionTranscriptItem,
    ExternalSessionTranscriptListener,
    ExternalSessionTranscriptQuery,
    ExternalSessionTranscriptReadResult,
} from './externalSessions.js';
import { ExternalSessionAgentIdSchema } from './externalSessions.js';
import type { SessionsService } from './sessions.js';

type IsRequired<T, Key extends keyof T> = {} extends Pick<T, Key> ? false : true;
type KeysOfUnion<T> = T extends T ? keyof T : never;

describe('External Sessions contextual service contract', () => {
    it('declares exactly the six contextual methods and a required Sessions service', async () => {
        expectTypeOf<keyof ExternalSessionsService>().toEqualTypeOf<
            | 'capabilities'
            | 'list'
            | 'attach'
            | 'readTranscript'
            | 'followTranscript'
            | 'takeover'
        >();
        expectTypeOf<ExternalSessionsService['capabilities']>()
            .toEqualTypeOf<(
                options?: PluginCancellationOptions,
            ) => Promise<ExternalSessionsCapabilities>>();
        expectTypeOf<ExternalSessionsService['list']>().toEqualTypeOf<(
            query?: ExternalSessionListQuery,
            options?: PluginCancellationOptions,
        ) => Promise<ExternalSessionListPage>>();
        expectTypeOf<ExternalSessionsService['attach']>().toEqualTypeOf<(
            ref: ExternalSessionRef,
            options?: PluginCancellationOptions,
        ) => Promise<ExternalSessionAttachResult>>();
        expectTypeOf<ExternalSessionsService['readTranscript']>().toEqualTypeOf<(
            ref: ExternalSessionRef,
            query: ExternalSessionTranscriptQuery,
            options?: PluginCancellationOptions,
        ) => Promise<ExternalSessionTranscriptReadResult>>();
        expectTypeOf<ExternalSessionsService['followTranscript']>().toEqualTypeOf<(
            ref: ExternalSessionRef,
            options: ExternalSessionTranscriptFollowOptions,
            listener: ExternalSessionTranscriptListener,
        ) => Promise<ExternalSessionTranscriptFollowResult>>();
        expectTypeOf<ExternalSessionsService['takeover']>().toEqualTypeOf<(
            ref: ExternalSessionRef,
            request: ExternalSessionTakeoverRequest,
            options?: PluginCancellationOptions,
        ) => Promise<ExternalSessionOperationReference>>();
        expectTypeOf<SessionsService['external']>().toEqualTypeOf<ExternalSessionsService>();
        expectTypeOf<IsRequired<SessionsService, 'external'>>().toEqualTypeOf<true>();

        const sourceText = await readFile(new URL('./externalSessions.ts', import.meta.url), 'utf8');
        const source = ts.createSourceFile(
            'externalSessions.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const service = source.statements.find(
            (statement): statement is ts.InterfaceDeclaration => (
                ts.isInterfaceDeclaration(statement)
                && statement.name.text === 'ExternalSessionsService'
            ),
        );
        expect(service?.members.map((member) => (
            member.name && ts.isIdentifier(member.name) ? member.name.text : null
        ))).toEqual([
            'capabilities',
            'list',
            'attach',
            'readTranscript',
            'followTranscript',
            'takeover',
        ]);

        const sessionsSourceText = await readFile(new URL('./sessions.ts', import.meta.url), 'utf8');
        const sessionsSource = ts.createSourceFile(
            'sessions.ts',
            sessionsSourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const sessionsService = sessionsSource.statements.find(
            (statement): statement is ts.InterfaceDeclaration => (
                ts.isInterfaceDeclaration(statement)
                && statement.name.text === 'SessionsService'
            ),
        );
        expect(sessionsService?.typeParameters).toBeUndefined();
    });

    it('uses public transcript, follow, takeover, and canonical operation projections', () => {
        expect(ExternalSessionAgentIdSchema).toBe(protocol.ExternalSessionAgentIdSchema);
        expect(ExternalSessionAgentIdSchema.safeParse(' codex').success).toBe(false);
        expectTypeOf<ExternalSessionAgentId>().toEqualTypeOf<protocol.ExternalSessionAgentId>();
        expectTypeOf<ExternalSessionSourceId>().toEqualTypeOf<protocol.ExternalSessionSourceId>();
        expectTypeOf<ExternalSessionRef>().toEqualTypeOf<protocol.ExternalSessionRef>();
        expectTypeOf<ExternalSessionOperationReference>()
            .toEqualTypeOf<protocol.ExternalSessionOperationReferenceV1>();
        expectTypeOf<ExternalSessionOperationPresentation>()
            .toEqualTypeOf<protocol.ExternalSessionOperationSharedPresentationV1>();
        expectTypeOf<ExternalSessionMaterializeActionResult>()
            .toEqualTypeOf<protocol.ExternalSessionMaterializeActionResultV1>();
        expectTypeOf<ExternalSessionOperationActionResult>()
            .toEqualTypeOf<protocol.ExternalSessionOperationActionResultV1>();
        expectTypeOf<ExternalSessionsCapabilities>().toEqualTypeOf<Readonly<{
            list: PluginOperationAvailability;
            attach: PluginOperationAvailability;
            takeover: ExternalSessionTakeoverCapability;
            transcript: PluginOperationAvailability;
            follow: PluginOperationAvailability;
        }>>();
        expectTypeOf<ExternalSessionListQuery>().toEqualTypeOf<Readonly<{
            agentId?: ExternalSessionAgentId;
            sourceId?: ExternalSessionSourceId;
            cursor?: string;
            limit?: number;
            maxBytes?: number;
        }>>();
        expectTypeOf<ExternalSessionCandidateRecord>().toEqualTypeOf<Readonly<{
            ref: ExternalSessionRef;
            title?: string;
            updatedAtMs?: number;
            capabilities: readonly ('attach' | 'transcript' | 'follow')[];
            takeover: ExternalSessionTakeoverCapability;
        }>>();
        expectTypeOf<ExternalSessionTakeoverCapability>().toEqualTypeOf<
            | Readonly<{ status: 'unavailable'; code: string }>
            | Readonly<{
                status: 'available';
                storageModes: readonly ('external-linked' | 'persisted')[];
            }>
        >();
        expectTypeOf<ExternalSessionListPage['diagnostics']>()
            .toEqualTypeOf<readonly PluginDiagnosticData[] | undefined>();
        expectTypeOf<ExternalSessionTranscriptItem['data']>().toEqualTypeOf<JsonValue>();
        expectTypeOf<ExternalSessionTranscriptQuery>().toEqualTypeOf<
            | Readonly<{
                mode: 'page';
                cursor?: string;
                direction: 'older' | 'newer';
                limit?: number;
                maxBytes?: number;
            }>
            | Readonly<{
                mode: 'readAfter';
                cursor: string;
                limit?: number;
                maxBytes?: number;
            }>
        >();
        expectTypeOf<ExternalSessionTranscriptReadResult>().toEqualTypeOf<
            | Readonly<{
                mode: 'page';
                items: readonly ExternalSessionTranscriptItem[];
                nextCursor: string | null;
                tailCursor?: string | null;
                hasMore?: boolean;
                truncated?: boolean;
            }>
            | Readonly<{ mode: 'readAfter'; outcome: 'already_current' }>
            | Readonly<{
                mode: 'readAfter';
                outcome: 'advanced';
                items: readonly ExternalSessionTranscriptItem[];
                nextCursor: string;
                boundary: string;
                diagnostics?: readonly ExternalSessionReadAfterDiagnostic[];
            }>
            | Readonly<{
                mode: 'readAfter';
                outcome:
                    | 'gap_or_cursor_expired'
                    | 'source_replaced'
                    | 'source_unavailable'
                    | 'read_failed';
            }>
        >();
        expectTypeOf<ExternalSessionTranscriptFollowOptions>()
            .toEqualTypeOf<PluginCancellationOptions & Readonly<{ cursor?: string }>>();
        expectTypeOf<ExternalSessionTranscriptFollowResult>().toEqualTypeOf<
            | Readonly<{
                status: 'following';
                startingCursor: string | null;
                subscription: Disposable;
            }>
            | Readonly<{ status: 'unavailable'; code: string }>
        >();
        expectTypeOf<ExternalSessionTranscriptFollowEvent>().toEqualTypeOf<
            | Readonly<{
                kind: 'data';
                items: readonly ExternalSessionTranscriptItem[];
                fromCursor: string | null;
                nextCursor: string;
            }>
            | Readonly<{
                kind: 'resyncRequired';
                reason: 'cursorDiscontinuity';
                cursor: string | null;
            }>
            | Readonly<{
                kind: 'terminated';
                reason:
                    | 'disposed'
                    | 'aborted'
                    | 'retired'
                    | 'providerFailure'
                    | 'resyncRequired';
                cursor: string | null;
                code?: string;
            }>
        >();
        expectTypeOf<ExternalSessionAttachResult>()
            .toEqualTypeOf<Readonly<{ sessionId: string }>>();
        expectTypeOf<ExternalSessionTakeoverIdempotencyKey>().toEqualTypeOf<string>();
        expectTypeOf<ExternalSessionTakeoverRequest>().toEqualTypeOf<Readonly<{
            targetStorageMode: 'external-linked' | 'persisted';
            idempotencyKey: ExternalSessionTakeoverIdempotencyKey;
        }>>();
        expectTypeOf<ExternalSessionReadAfterDiagnostic>().toEqualTypeOf<Readonly<{
            code: string;
            count: number;
            positions: readonly number[];
        }>>();
    });

    it('keeps private source, machine, generation, progress, and custody fields absent', () => {
        type PublicCarrier =
            | ExternalSessionRef
            | ExternalSessionCandidateRecord
            | ExternalSessionTranscriptItem
            | ExternalSessionTranscriptReadResult
            | ExternalSessionTranscriptFollowEvent
            | ExternalSessionTranscriptFollowResult
            | ExternalSessionTakeoverRequest
            | ExternalSessionOperationReference
            | ExternalSessionMaterializeActionResult
            | ExternalSessionOperationActionResult;
        type PrivateField =
            | 'source'
            | 'machineId'
            | 'generation'
            | 'progress'
            | 'custody'
            | 'claim'
            | 'fence'
            | 'checkpoints'
            | 'publication'
            | 'retryTargetPhase'
            | 'targetDirectory';

        expectTypeOf<Extract<KeysOfUnion<PublicCarrier>, PrivateField>>()
            .toEqualTypeOf<never>();
        expectTypeOf<ExternalSessionOperationReference>().not.toHaveProperty('presentation');
        expectTypeOf<ExternalSessionOperationPresentation>().not.toHaveProperty('timeline');
        expectTypeOf<ExternalSessionCandidateRecord>().not.toHaveProperty('source');
        expectTypeOf<ExternalSessionTranscriptItem>().not.toHaveProperty('path');
    });
});
